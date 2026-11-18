import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SemanticSearch from "@/components/MotearyWorkspace/SemanticSearch";
import { queryClient } from "@/lib/query-client";

const auth = vi.hoisted(() => vi.fn());
vi.mock("@/connect", () => ({ authServiceClient: { getCurrentUser: auth } }));
vi.mock("@/auth-state", () => ({ getAccessToken: () => "synthetic-token" }));
const fetchMock = vi.fn();
const result = {
  hits: [{ name: "memos/one", score: 0.8, excerpt: "<img src=x onerror=alert(1)>" }],
  model: "local",
  revision: "fixed",
  truncated: true,
};
const response = (body: object, status = 200) => new Response(JSON.stringify(body), { status });
const mount = () =>
  render(
    <MemoryRouter>
      <SemanticSearch userName="users/alice" filter="creator == alice" />
    </MemoryRouter>,
  );
const submit = () => {
  fireEvent.change(screen.getByLabelText("语义找回描述"), { target: { value: "寻找以前的想法" } });
  fireEvent.click(screen.getByRole("button", { name: "尝试语义找回" }));
};
describe("Semantic retrieval opt-in UI", () => {
  beforeEach(() => {
    queryClient.clear();
    auth.mockReset().mockResolvedValue({ user: { name: "users/alice" } });
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  it("sends nothing automatically and stops before content POST when a model is unavailable", async () => {
    fetchMock.mockResolvedValue(response({ available: false }));
    mount();
    expect(auth).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("模型未配置或不可用");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("refreshes identity before each request and renders source excerpts as plain text", async () => {
    fetchMock.mockResolvedValueOnce(response({ available: true })).mockResolvedValueOnce(response(result));
    mount();
    submit();
    expect(await screen.findByText(result.hits[0].excerpt)).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByRole("link", { name: /打开原记录/ })).toHaveAttribute("href", "/memos/one");
    expect(screen.getByText(/候选已截断/)).toBeInTheDocument();
    expect(auth).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ query: "寻找以前的想法", filter: "creator == alice", offset: 0 });
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer synthetic-token");
  });
  it.each([
    [429, "本地语义模型正忙"],
    [503, "本地语义模型未配置或校验未通过"],
  ] as const)("explains processor status %s without submitting the query", async (status, message) => {
    fetchMock.mockResolvedValueOnce(response({}, status));
    mount();
    expect(screen.getByRole("heading", { name: "相关片段候选 · 实验功能" })).toBeInTheDocument();
    expect(screen.getByText(/跨语言查询可能漏找/)).toBeInTheDocument();
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("clears misleading candidates locally without treating similarity as an answer", async () => {
    fetchMock.mockResolvedValueOnce(response({ available: true })).mockResolvedValueOnce(response(result));
    mount();
    submit();
    await screen.findByText(result.hits[0].excerpt);
    fireEvent.click(screen.getByRole("button", { name: "这些候选没有回答我的问题" }));
    expect(screen.queryByText(result.hits[0].excerpt)).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("没有记录为答案");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("clears displayed excerpts on an offline event without automatically retrying", async () => {
    fetchMock.mockResolvedValueOnce(response({ available: true })).mockResolvedValueOnce(response(result));
    mount();
    submit();
    await screen.findByText(result.hits[0].excerpt);
    fireEvent(window, new Event("offline"));
    expect(screen.queryByText(result.hits[0].excerpt)).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("旧候选已清除");
    fireEvent(window, new Event("online"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("keeps errors distinct from empty successful results", async () => {
    fetchMock.mockResolvedValueOnce(response({ available: true })).mockResolvedValueOnce(response({}, 500));
    mount();
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("语义找回失败");
    expect(screen.queryByText(/未找到相关记录/)).not.toBeInTheDocument();
  });
  it("does not send content after the authenticated account changes", async () => {
    auth.mockResolvedValueOnce({ user: { name: "users/alice" } }).mockResolvedValueOnce({ user: { name: "users/bob" } });
    fetchMock.mockResolvedValueOnce(response({ available: true }));
    mount();
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("账户已变化");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("clears source excerpts when the existing memo cache invalidation reports changes", async () => {
    queryClient.setQueryData(["memos", "list"], []);
    fetchMock.mockResolvedValueOnce(response({ available: true })).mockResolvedValueOnce(response(result));
    mount();
    submit();
    await screen.findByText(result.hits[0].excerpt);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["memos"] });
    });
    expect(screen.queryByText(result.hits[0].excerpt)).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each(["cancel", "scope", "account", "unmount", "invalidation", "offline"])("ignores late search results after %s", async (reason) => {
    queryClient.setQueryData(["memos", "list"], []);
    let finish: ((value: Response) => void) | undefined;
    fetchMock.mockResolvedValueOnce(response({ available: true })).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = mount();
    submit();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const signal = fetchMock.mock.calls[1][1].signal;
    if (reason === "cancel") fireEvent.click(screen.getByRole("button", { name: "取消语义找回" }));
    else if (reason === "offline") fireEvent(window, new Event("offline"));
    else if (reason === "invalidation")
      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ["memos"] });
      });
    else if (reason === "unmount") view.unmount();
    else
      view.rerender(
        <MemoryRouter>
          <SemanticSearch userName={reason === "account" ? "users/bob" : "users/alice"} filter="different scope" />
        </MemoryRouter>,
      );
    expect(signal.aborted).toBe(true);
    await act(async () => {
      finish?.(response(result));
    });
    expect(screen.queryByText(result.hits[0].excerpt)).not.toBeInTheDocument();
    if (reason === "scope" || reason === "account") expect(screen.getByLabelText("语义找回描述")).toHaveValue("");
  });
  it("labels every result as candidates and safely highlights only a literal query", async () => {
    fetchMock.mockResolvedValueOnce(response({ available: true })).mockResolvedValueOnce(response(result));
    mount();
    fireEvent.change(screen.getByLabelText("语义找回描述"), { target: { value: result.hits[0].excerpt } });
    fireEvent.click(screen.getByRole("button", { name: "尝试语义找回" }));
    expect(await screen.findByText("这些是相近候选，可能没有答案。请核对原文。")).toBeInTheDocument();
    expect(screen.getByText(result.hits[0].excerpt).tagName).toBe("MARK");
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("模型相似匹配 · 请核对原文")).toBeInTheDocument();
  });
  it.each([0, 5])("does not present an empty batch with total %s as an AI no-answer judgment", async (total) => {
    fetchMock
      .mockResolvedValueOnce(response({ available: true }))
      .mockResolvedValueOnce(response({ ...result, hits: [], total, scanned: total }));
    mount();
    submit();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(total === 0 ? "当前范围没有候选记录" : "本批没有可比较正文或没有返回候选"),
    );
    expect(screen.getByRole("status")).toHaveTextContent("不是模型判断没有答案");
  });
  const page = {
    ...result,
    snapshot: "snapshot-one",
    nextOffset: 100,
    scanned: 100,
    total: 150,
    candidateTruncated: true,
    passageTruncated: true,
    skipped: 1,
  };
  it("continues the snapshot at nextOffset and replaces rather than aggregates old hits", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ available: true }))
      .mockResolvedValueOnce(response(page))
      .mockResolvedValueOnce(response({ available: true }))
      .mockResolvedValueOnce(
        response({ ...page, nextOffset: undefined, scanned: 150, hits: [{ name: "memos/two", score: 0.7, excerpt: "older source" }] }),
      );
    mount();
    submit();
    fireEvent.click(await screen.findByRole("button", { name: "继续检索更早资料" }));
    await screen.findByText("older source");
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({
      query: "寻找以前的想法",
      filter: "creator == alice",
      offset: 100,
      snapshot: "snapshot-one",
    });
    expect(screen.getByText(/本批覆盖 101 至 150/)).toBeInTheDocument();
    expect(screen.queryByText(result.hits[0].excerpt)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "继续检索更早资料" })).not.toBeInTheDocument();
  });
  it("discards pagination on snapshot conflict and restarts without the old token", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ available: true }))
      .mockResolvedValueOnce(response(page))
      .mockResolvedValueOnce(response({ available: true }))
      .mockResolvedValueOnce(response({}, 409))
      .mockResolvedValueOnce(response({ available: true }))
      .mockResolvedValueOnce(response(result));
    mount();
    submit();
    fireEvent.click(await screen.findByRole("button", { name: "继续检索更早资料" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("从第一批重新开始");
    expect(screen.queryByRole("button", { name: "继续检索更早资料" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "尝试语义找回" }));
    await screen.findByText(result.hits[0].excerpt);
    expect(JSON.parse(fetchMock.mock.calls[5][1].body)).toEqual({ query: "寻找以前的想法", filter: "creator == alice", offset: 0 });
  });
  it("ignores a cancelled next page and does not allow duplicate continuation requests", async () => {
    let finish: ((value: Response) => void) | undefined;
    fetchMock
      .mockResolvedValueOnce(response({ available: true }))
      .mockResolvedValueOnce(response(page))
      .mockResolvedValueOnce(response({ available: true }))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    mount();
    submit();
    const next = await screen.findByRole("button", { name: "继续检索更早资料" });
    fireEvent.click(next);
    fireEvent.click(next);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    const signal = fetchMock.mock.calls[3][1].signal;
    fireEvent.click(screen.getByRole("button", { name: "取消语义找回" }));
    expect(signal.aborted).toBe(true);
    await act(async () => {
      finish?.(response(page));
    });
    expect(screen.queryByText(result.hits[0].excerpt)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "继续检索更早资料" })).not.toBeInTheDocument();
  });
  it("clears the previous page token immediately when the query changes", async () => {
    fetchMock.mockResolvedValueOnce(response({ available: true })).mockResolvedValueOnce(response(page));
    mount();
    submit();
    await screen.findByRole("button", { name: "继续检索更早资料" });
    fireEvent.change(screen.getByLabelText("语义找回描述"), { target: { value: "different question" } });
    expect(screen.queryByRole("button", { name: "继续检索更早资料" })).not.toBeInTheDocument();
    expect(screen.queryByText(result.hits[0].excerpt)).not.toBeInTheDocument();
  });
});

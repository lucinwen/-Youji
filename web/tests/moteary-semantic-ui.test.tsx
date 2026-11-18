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
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ query: "寻找以前的想法", filter: "creator == alice" });
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer synthetic-token");
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
  it.each(["cancel", "scope", "account", "unmount", "invalidation"])("ignores late search results after %s", async (reason) => {
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
});

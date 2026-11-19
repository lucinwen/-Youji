import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PrivateSource from "@/components/MotearyWorkspace/PrivateSource";
import SourcePicker from "@/components/MotearyWorkspace/SourcePicker";
import { Visibility } from "@/types/proto/api/memo_service_pb";

vi.mock("@/connect", () => ({ getRequestToken: async () => "synthetic-token" }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const candidate = (name: string, label = "相同标题") => ({ name, label, eventDate: "2026-11-14", createdAt: "2026-11-19T07:00:00Z" });
const view = (user = "users/alice") => <PrivateSource name="memos/review" userName={user} visibility={Visibility.PRIVATE} />;
const search = () => fireEvent.submit(screen.getByLabelText("来源关键词（可留空列出自己的私密记录）").closest("form")!);

describe("explicit private source picker", () => {
  it("does not search automatically, selects same-title candidates by native radio and sends only exact ID", async () => {
    const fetch = vi.fn(async (url: string, options: RequestInit) => {
      if (url.includes("/candidates?"))
        return response({ candidates: [candidate("memos/a"), candidate("memos/b")], nextPageToken: "", content: "unexpected secret" });
      if (options.method === "PATCH") return response({ status: "available", sourceName: JSON.parse(String(options.body)).sourceName });
      return response({ status: "none" });
    });
    vi.stubGlobal("fetch", fetch);
    render(view());
    await screen.findByText("未设置来源");
    fireEvent.click(screen.getByRole("button", { name: "选择私密来源" }));
    expect(fetch).toHaveBeenCalledTimes(1);
    const field = screen.getByLabelText("来源关键词（可留空列出自己的私密记录）");
    fireEvent.change(field, { target: { value: 'x") || true' } });
    expect(fetch).toHaveBeenCalledTimes(1);
    search();
    const radios = await screen.findAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(radios.every((radio) => radio.getAttribute("name") === radios[0].getAttribute("name"))).toBe(true);
    radios[1].focus();
    expect(document.activeElement).toBe(radios[1]);
    fireEvent.click(radios[1]);
    expect(radios[1]).toBeChecked();
    expect(screen.getByRole("button", { name: "使用所选来源" })).toBeEnabled();
    fireEvent.submit(radios[1].closest("form")!);
    await screen.findByText("已关联来源 ID：memos/b");
    expect(screen.queryByText("相同标题")).not.toBeInTheDocument();
    expect(screen.queryByText("unexpected secret")).not.toBeInTheDocument();
    const searchCall = fetch.mock.calls.find(([url]) => url.includes("/candidates?"))!;
    expect(new URL(searchCall[0], "http://localhost").searchParams.get("q")).toBe('x") || true');
    const patch = fetch.mock.calls.find(([, options]) => options.method === "PATCH")!;
    expect(JSON.parse(String(patch[1].body))).toEqual({ sourceName: "memos/b" });
    expect(fetch.mock.calls.some(([url]) => url.endsWith("/open"))).toBe(false);
  });
  it("loads additional pages for applied query, resets selection and removes all labels on failure", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response({ candidates: [candidate("memos/a")], nextPageToken: "next-one" }))
      .mockResolvedValueOnce(response({ candidates: [candidate("memos/b")], nextPageToken: "next-two" }))
      .mockResolvedValueOnce(response({}, 409));
    vi.stubGlobal("fetch", fetch);
    render(<SourcePicker name="memos/review" onSelect={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("来源关键词（可留空列出自己的私密记录）"), { target: { value: "岗位" } });
    search();
    fireEvent.click(await screen.findByRole("radio"));
    fireEvent.change(screen.getByLabelText("来源关键词（可留空列出自己的私密记录）"), { target: { value: "尚未应用的新词" } });
    fireEvent.click(screen.getByRole("button", { name: "加载更多来源" }));
    await waitFor(() => expect(screen.getAllByRole("radio")).toHaveLength(2));
    expect(screen.getByRole("button", { name: "使用所选来源" })).toBeDisabled();
    const url = new URL(fetch.mock.calls[1][0], "http://localhost");
    expect(url.searchParams.get("q")).toBe("岗位");
    expect(url.searchParams.get("pageToken")).toBe("next-one");
    fireEvent.click(screen.getByRole("button", { name: "加载更多来源" }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByText("相同标题")).not.toBeInTheDocument();
  });
  it("continues after an empty live page with a next token", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response({ candidates: [], nextPageToken: "after-revoked" }))
      .mockResolvedValueOnce(response({ candidates: [candidate("memos/still-private")], nextPageToken: "" }));
    vi.stubGlobal("fetch", fetch);
    render(<SourcePicker name="memos/review" onSelect={vi.fn()} onClose={vi.fn()} />);
    search();
    await screen.findByText("本页没有当前可用来源，可继续加载或重新搜索。");
    fireEvent.click(screen.getByRole("button", { name: "加载更多来源" }));
    await screen.findByRole("radio");
    expect(new URL(fetch.mock.calls[1][0], "http://localhost").searchParams.get("pageToken")).toBe("after-revoked");
  });
  it("explicit Enter searches and confirms selection, Escape closes and restores trigger focus", async () => {
    const fetch = vi.fn(async (url: string, options: RequestInit) => {
      if (url.includes("/candidates?")) return response({ candidates: [candidate("memos/a"), candidate("memos/b")], nextPageToken: "" });
      if (options.method === "PATCH") return response({ status: "available", sourceName: JSON.parse(String(options.body)).sourceName });
      return response({ status: "none" });
    });
    vi.stubGlobal("fetch", fetch);
    render(view());
    await screen.findByText("未设置来源");
    const trigger = screen.getByRole("button", { name: "选择私密来源" });
    fireEvent.click(trigger);
    const field = screen.getByLabelText("来源关键词（可留空列出自己的私密记录）");
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(field, { key: "Enter" });
    const radios = await screen.findAllByRole("radio");
    // jsdom does not implement browser Space/Arrow activation; use native radio click only for selection setup.
    fireEvent.click(radios[1]);
    fireEvent.keyDown(screen.getByRole("button", { name: "使用所选来源" }), { key: "Enter" });
    await screen.findByText("已关联来源 ID：memos/b");
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByLabelText("来源关键词（可留空列出自己的私密记录）"), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "搜索并选择私密来源" })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });
  it("pins the explicitly chosen ID despite same-title newer edits and later query reordering", async () => {
    const correct = { ...candidate("memos/correct-brief", "岗位简报"), eventDate: "2026-11-10", createdAt: "2026-11-11T01:00:00Z" };
    const wrongNewest = { ...candidate("memos/wrong-newest", "岗位简报"), eventDate: "2026-11-18", createdAt: "2026-11-19T01:00:00Z" };
    let stored: string | null = null;
    let searches = 0;
    const fetch = vi.fn(async (url: string, options: RequestInit) => {
      if (url.includes("/candidates?"))
        return response({ candidates: ++searches === 1 ? [wrongNewest, correct] : [correct, wrongNewest], nextPageToken: "" });
      if (options.method === "PATCH") stored = JSON.parse(String(options.body)).sourceName;
      return response(stored ? { status: "available", sourceName: stored } : { status: "none" });
    });
    vi.stubGlobal("fetch", fetch);
    render(view());
    await screen.findByText("未设置来源");
    fireEvent.click(screen.getByRole("button", { name: "选择私密来源" }));
    search();
    const correctRadio = await screen.findByRole("radio", { name: /memos\/correct-brief.*2026-11-10/ });
    expect(screen.getByRole("radio", { name: /memos\/wrong-newest.*2026-11-18/ })).toBeInTheDocument();
    fireEvent.click(correctRadio);
    fireEvent.click(screen.getByRole("button", { name: "使用所选来源" }));
    await screen.findByText("已关联来源 ID：memos/correct-brief");
    fireEvent.click(screen.getByRole("button", { name: "选择私密来源" }));
    fireEvent.change(screen.getByLabelText("来源关键词（可留空列出自己的私密记录）"), { target: { value: "不同查询" } });
    search();
    await screen.findByRole("radio", { name: /memos\/wrong-newest/ });
    expect(screen.getAllByRole("radio").every((radio) => !(radio as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByRole("button", { name: "使用所选来源" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "关闭来源选择" }));
    fireEvent.click(screen.getByRole("button", { name: "重新核对来源" }));
    await screen.findByText("已关联来源 ID：memos/correct-brief");
    expect(fetch.mock.calls.filter(([, options]) => options.method === "PATCH")).toHaveLength(1);
    expect(stored).toBe("memos/correct-brief");
  });
  it("reports empty results and searches only after explicit action", async () => {
    const fetch = vi.fn(async () => response({ candidates: [], nextPageToken: "" }));
    vi.stubGlobal("fetch", fetch);
    render(<SourcePicker name="memos/review" onSelect={vi.fn()} onClose={vi.fn()} />);
    expect(fetch).not.toHaveBeenCalled();
    search();
    await screen.findByText("没有找到可用私密来源。可更换关键词重新搜索。");
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });
  it("revoked selection fails neutrally without keeping candidate label or querying body", async () => {
    const fetch = vi.fn(async (url: string, options: RequestInit) => {
      if (url.includes("/candidates?")) return response({ candidates: [candidate("memos/a", "will be revoked")], nextPageToken: "" });
      if (options.method === "PATCH") return response({}, 409);
      return response({ status: "none" });
    });
    vi.stubGlobal("fetch", fetch);
    render(view());
    await screen.findByText("未设置来源");
    fireEvent.click(screen.getByRole("button", { name: "选择私密来源" }));
    search();
    fireEvent.click(await screen.findByRole("radio"));
    fireEvent.click(screen.getByRole("button", { name: "使用所选来源" }));
    await screen.findByRole("alert");
    expect(screen.queryByText("will be revoked")).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByText("来源当前不可用")).toBeInTheDocument();
    expect(fetch.mock.calls.some(([url]) => url.endsWith("/open"))).toBe(false);
  });
  it("account change cancels pending results and late labels do not appear for new account", async () => {
    let finish!: (r: Response) => void;
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options: RequestInit) => {
        if (!url.includes("/candidates?")) return response({ status: "none" });
        signal = options.signal as AbortSignal;
        return new Promise<Response>((r) => {
          finish = r;
        });
      }),
    );
    const mounted = render(view());
    await screen.findByText("未设置来源");
    fireEvent.click(screen.getByRole("button", { name: "选择私密来源" }));
    search();
    await waitFor(() => expect(finish).toBeDefined());
    mounted.rerender(view("users/bob"));
    expect(signal?.aborted).toBe(true);
    await act(async () => finish(response({ candidates: [candidate("memos/a", "alice-only label")], nextPageToken: "" })));
    expect(screen.queryByText("alice-only label")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("搜索并选择私密来源")).not.toBeInTheDocument();
  });
  it("close and blur discard candidates and selection, reopen does not auto-search", async () => {
    const fetch = vi.fn(async (url: string) =>
      url.includes("/candidates?")
        ? response({ candidates: [candidate("memos/a", "ephemeral label")], nextPageToken: "" })
        : response({ status: "none" }),
    );
    vi.stubGlobal("fetch", fetch);
    render(view());
    await screen.findByText("未设置来源");
    fireEvent.click(screen.getByRole("button", { name: "选择私密来源" }));
    search();
    await screen.findByText("ephemeral label");
    fireEvent.click(screen.getByRole("button", { name: "关闭来源选择" }));
    expect(screen.queryByText("ephemeral label")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "选择私密来源" }));
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    search();
    await screen.findByText("ephemeral label");
    fireEvent(window, new Event("blur"));
    expect(screen.queryByText("ephemeral label")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("搜索并选择私密来源")).not.toBeInTheDocument();
    expect(fetch.mock.calls.filter(([url]) => url.includes("/candidates?")).length).toBe(2);
  });
});

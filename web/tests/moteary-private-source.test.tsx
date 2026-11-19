import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PrivateSource, { requestPrivateSource } from "@/components/MotearyWorkspace/PrivateSource";
import { Visibility } from "@/types/proto/api/memo_service_pb";

vi.mock("@/connect", () => ({ getRequestToken: async () => "synthetic-token" }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const available = { status: "available", sourceName: "memos/brief-a" };
const view = (userName = "users/alice", visibility = Visibility.PRIVATE) => (
  <PrivateSource name="memos/review" userName={userName} visibility={visibility} />
);

describe("private source references", () => {
  it("metadata strips unexpected title/body and displays exact source ID", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ ...available, title: "Same title", content: "must not display" })),
    );
    render(view());
    await screen.findByText("已关联来源 ID：memos/brief-a");
    expect(screen.queryByText("Same title")).not.toBeInTheDocument();
    expect(screen.queryByText("must not display")).not.toBeInTheDocument();
  });
  it("opens freshly each time, clears old text before revalidation and renders malicious-looking text literally", async () => {
    const body = '<img src="https://invalid.example/a" onerror="alert(1)"> [link](https://invalid.example)';
    let resolve!: (value: Response) => void;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(available))
      .mockResolvedValueOnce(response({ ...available, content: body }))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((r) => {
            resolve = r;
          }),
      );
    vi.stubGlobal("fetch", fetch);
    render(view());
    await screen.findByText("已关联来源 ID：memos/brief-a");
    fireEvent.click(screen.getByRole("button", { name: "打开来源原文（重新核对）" }));
    await screen.findByText(body);
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("a")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "打开来源原文（重新核对）" }));
    expect(screen.queryByText(body)).not.toBeInTheDocument();
    await waitFor(() => expect(resolve).toBeDefined());
    await act(async () => resolve(response({ status: "unavailable", content: body, sourceName: available.sourceName })));
    expect(screen.queryByText(body)).not.toBeInTheDocument();
    expect(screen.queryByText(/已关联来源 ID/)).not.toBeInTheDocument();
    expect(fetch.mock.calls.slice(1).every(([url]) => String(url).endsWith("/source/open"))).toBe(true);
    expect(fetch.mock.calls.every(([, options]) => options.cache === "no-store")).toBe(true);
  });
  it("sets exact IDs to distinguish same titles and clears using null", async () => {
    const fetch = vi.fn(async (_url, options: RequestInit) => {
      if (options.method === "PATCH") {
        const name = JSON.parse(String(options.body)).sourceName;
        return response(name ? { status: "available", sourceName: name } : { status: "none" });
      }
      return response({ status: "none" });
    });
    vi.stubGlobal("fetch", fetch);
    render(view());
    await screen.findByText("未设置来源");
    for (const name of ["memos/same-title-a", "memos/same-title-b"]) {
      fireEvent.change(screen.getByLabelText("来源记录 ID"), { target: { value: name } });
      fireEvent.click(screen.getByRole("button", { name: "设置来源" }));
      await screen.findByText(`已关联来源 ID：${name}`);
    }
    fireEvent.click(screen.getByRole("button", { name: "清除来源" }));
    await screen.findByText("未设置来源");
    expect(JSON.parse(String(fetch.mock.calls.at(-1)?.[1].body))).toEqual({ sourceName: null });
    expect(screen.getByLabelText("来源记录 ID")).toHaveValue("");
  });
  it("clears previous source text after a failed fresh check", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(response(available))
        .mockResolvedValueOnce(response({ ...available, content: "synthetic private body" }))
        .mockResolvedValueOnce(response({}, 404)),
    );
    render(view());
    await screen.findByText("已关联来源 ID：memos/brief-a");
    fireEvent.click(screen.getByRole("button", { name: "打开来源原文（重新核对）" }));
    await screen.findByText("synthetic private body");
    fireEvent.click(screen.getByRole("button", { name: "重新核对来源" }));
    expect(screen.queryByText("synthetic private body")).not.toBeInTheDocument();
    await screen.findByRole("alert");
    expect(screen.queryByText(/已关联来源 ID/)).not.toBeInTheDocument();
  });
  it("closing cancels pending open and ignores a late body", async () => {
    let finish!: (value: Response) => void;
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(response(available))
        .mockImplementationOnce((_url, options: RequestInit) => {
          signal = options.signal as AbortSignal;
          return new Promise<Response>((r) => {
            finish = r;
          });
        }),
    );
    render(view());
    await screen.findByText("已关联来源 ID：memos/brief-a");
    fireEvent.click(screen.getByRole("button", { name: "打开来源原文（重新核对）" }));
    await waitFor(() => expect(finish).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "关闭来源视图" }));
    expect(signal?.aborted).toBe(true);
    await act(async () => finish(response({ ...available, content: "late confidential body" })));
    expect(screen.queryByText("late confidential body")).not.toBeInTheDocument();
  });
  it("account changes abort old requests and do not resurrect old source text", async () => {
    let finish!: (value: Response) => void;
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(response(available))
        .mockImplementationOnce((_url, options: RequestInit) => {
          signal = options.signal as AbortSignal;
          return new Promise<Response>((r) => {
            finish = r;
          });
        })
        .mockResolvedValueOnce(response({}, 404)),
    );
    const mounted = render(view());
    await screen.findByText("已关联来源 ID：memos/brief-a");
    fireEvent.click(screen.getByRole("button", { name: "打开来源原文（重新核对）" }));
    await waitFor(() => expect(finish).toBeDefined());
    mounted.rerender(view("users/bob"));
    expect(signal?.aborted).toBe(true);
    await act(async () => finish(response({ ...available, content: "alice-only body" })));
    await screen.findByRole("alert");
    expect(screen.queryByText("alice-only body")).not.toBeInTheDocument();
    expect(screen.queryByText(/已关联来源 ID/)).not.toBeInTheDocument();
  });
  it("visibility changes unmount private reference body and private restoration rereads metadata", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(available))
      .mockResolvedValueOnce(response({ ...available, content: "private source" }))
      .mockResolvedValueOnce(response({ status: "unavailable" }));
    vi.stubGlobal("fetch", fetch);
    const mounted = render(view());
    await screen.findByText("已关联来源 ID：memos/brief-a");
    fireEvent.click(screen.getByRole("button", { name: "打开来源原文（重新核对）" }));
    await screen.findByText("private source");
    mounted.rerender(view("users/alice", Visibility.PUBLIC));
    expect(screen.queryByText("private source")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("私密来源引用")).not.toBeInTheDocument();
    mounted.rerender(view());
    await screen.findByText("来源当前不可用");
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("hides delivered text on blur and freshly revalidates only metadata on focus", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(available))
      .mockResolvedValueOnce(response({ ...available, content: "visible until blur" }))
      .mockResolvedValueOnce(response({ status: "unavailable" }));
    vi.stubGlobal("fetch", fetch);
    render(view());
    await screen.findByText("已关联来源 ID：memos/brief-a");
    fireEvent.click(screen.getByRole("button", { name: "打开来源原文（重新核对）" }));
    await screen.findByText("visible until blur");
    fireEvent(window, new Event("blur"));
    expect(screen.queryByText("visible until blur")).not.toBeInTheDocument();
    expect(screen.getByLabelText("来源记录 ID")).toHaveValue("");
    fireEvent(window, new Event("focus"));
    await screen.findByText("来源当前不可用");
    expect(fetch.mock.calls.at(-1)?.[0]).toBe("/api/youji/memos/review/source");
    expect(screen.queryByText("visible until blur")).not.toBeInTheDocument();
  });
  it("rejects invalid source ID without sending a request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      requestPrivateSource("memos/review", { kind: "save", sourceName: "https://invalid.example/memos/id" }, new AbortController().signal),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

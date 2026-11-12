import { webcrypto } from "node:crypto";
import { Code, ConnectError } from "@connectrpc/connect";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BatchImport from "@/components/MotearyWorkspace/BatchImport";
import { ingestBatchSource, prepareBatch } from "@/components/MotearyWorkspace/batchImport";
import { Visibility } from "@/types/proto/api/memo_service_pb";

const { getMemo, createMemo, createAttachment } = vi.hoisted(() => ({ getMemo: vi.fn(), createMemo: vi.fn(), createAttachment: vi.fn() }));
vi.mock("@/connect", () => ({ memoServiceClient: { getMemo, createMemo }, attachmentServiceClient: { createAttachment } }));
vi.mock("@/auth-state", () => ({ getAccessToken: () => null }));
const file = (name: string, body = "合成资料") =>
  ({
    name,
    size: new TextEncoder().encode(body).length,
    type: "text/plain",
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  }) as File;

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  getMemo.mockReset().mockRejectedValue(new ConnectError("missing", Code.NotFound));
  createAttachment.mockReset().mockResolvedValue({ name: "attachments/test" });
  createMemo.mockReset().mockResolvedValue({ name: "memos/test" });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("batch sources", () => {
  it("rejects empty, too many, and oversized batches before file reads", async () => {
    await expect(prepareBatch([], "diary", "", "users/alice")).rejects.toThrow();
    await expect(prepareBatch(Array(33).fill(file("a.txt")), "diary", "", "users/alice")).rejects.toThrow();
    await expect(prepareBatch([{ ...file("a.txt"), size: 17 * 1024 * 1024 } as File], "diary", "", "users/alice")).rejects.toThrow();
  });
  it("rejects duplicate sources and retains kind and note in identity", async () => {
    await expect(prepareBatch([file("a.txt"), file("a.txt")], "diary", "", "users/alice")).rejects.toThrow("重复");
    const a = (await prepareBatch([file("a.txt")], "diary", "", "users/alice"))[0];
    const b = (await prepareBatch([file("a.txt")], "work", "", "users/alice"))[0];
    expect(a.id).not.toBe(b.id);
    expect(a.content).toContain("合成资料");
  });
  it("writes private memos and byte-preserving zip without deleting", async () => {
    const item = (await prepareBatch([file("a.txt")], "diary", "我的批注", "users/alice"))[0];
    await ingestBatchSource(item, new AbortController().signal);
    const zip = createAttachment.mock.calls[0][0].attachment.content;
    expect(unzipSync(zip)["a.txt"]).toEqual(item.data);
    expect(createMemo.mock.calls[0][0].memo.visibility).toBe(Visibility.PRIVATE);
  });
  it("does not mistake forbidden access for a missing memo", async () => {
    getMemo.mockRejectedValue(new ConnectError("no", Code.PermissionDenied));
    const item = (await prepareBatch([file("a.txt")], "diary", "", "users/alice"))[0];
    await expect(ingestBatchSource(item, new AbortController().signal)).rejects.toThrow();
    expect(createAttachment).not.toHaveBeenCalled();
  });
  it("refuses altered scope or content before uploads", async () => {
    const item = (await prepareBatch([file("a.txt")], "diary", "", "users/alice"))[0];
    getMemo.mockResolvedValue({ visibility: Visibility.PUBLIC, content: item.content });
    await expect(ingestBatchSource(item, new AbortController().signal)).rejects.toThrow("权限");
    expect(createAttachment).not.toHaveBeenCalled();
  });
  it("requires preflight, ignores repeated save and shows real completion", async () => {
    render(<BatchImport onSaved={vi.fn()} userName="users/alice" />);
    fireEvent.change(screen.getByLabelText("批量资料文件"), { target: { files: [file("a.txt")] } });
    expect(createMemo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "预检这批资料" }));
    await screen.findByText("已预检，尚未保存");
    const save = screen.getByRole("button", { name: "保存为私有记录 / 复核重试" });
    fireEvent.click(save);
    fireEvent.click(save);
    await screen.findByText("已保存");
    expect(createMemo).toHaveBeenCalledOnce();
  });
  it("stops on uncertain save and does not process following files", async () => {
    createMemo.mockRejectedValue(new Error("private details"));
    render(<BatchImport onSaved={vi.fn()} userName="users/alice" />);
    fireEvent.change(screen.getByLabelText("批量资料文件"), { target: { files: [file("a.txt"), file("b.txt")] } });
    fireEvent.click(screen.getByRole("button", { name: "预检这批资料" }));
    await waitFor(() => expect(screen.getAllByText("已预检，尚未保存")).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "保存为私有记录 / 复核重试" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("可能已写入");
    expect(screen.queryByText("private details")).not.toBeInTheDocument();
    expect(createMemo).toHaveBeenCalledOnce();
    expect(screen.getByText("已预检，尚未保存")).toBeInTheDocument();
  });
});

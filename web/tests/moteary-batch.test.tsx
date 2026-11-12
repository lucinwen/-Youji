import { webcrypto } from "node:crypto";
import { Code, ConnectError } from "@connectrpc/connect";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BatchImport from "@/components/MotearyWorkspace/BatchImport";
import {
  buildBatchReceipt,
  checkOtherEntry,
  ingestBatchSource,
  MAX_FILE,
  prepareBatch,
  prepareLongBatch,
  readOriginalArchive,
  validateBatchQuota,
} from "@/components/MotearyWorkspace/batchImport";
import { Visibility } from "@/types/proto/api/memo_service_pb";

const { getMemo, createMemo, createAttachment, getUserUsage, listMemos } = vi.hoisted(() => ({
  getMemo: vi.fn(),
  createMemo: vi.fn(),
  createAttachment: vi.fn(),
  getUserUsage: vi.fn(),
  listMemos: vi.fn(),
}));
vi.mock("@/connect", () => ({
  memoServiceClient: { getMemo, createMemo, listMemos },
  attachmentServiceClient: { createAttachment },
  userServiceClient: { getUserUsage },
}));
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
  listMemos.mockReset().mockResolvedValue({ memos: [], nextPageToken: "" });
  getUserUsage.mockReset().mockResolvedValue({ limits: { memoContentBytes: 8192n } });
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
    expect(screen.getByRole("link", { name: "查看记录 a.txt" })).toHaveAttribute("target", "_blank");
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

describe("bounded original download", () => {
  it("preserves chunks without trusting Content-Length", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3]));
          controller.close();
        },
      }),
    );
    expect(await readOriginalArchive(response, new AbortController().signal)).toEqual(new Uint8Array([1, 2, 3]));
  });
  it("rejects a declared oversized archive before consuming it", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { headers: { "content-length": String(MAX_FILE * 2) } });
    await expect(readOriginalArchive(response, new AbortController().signal)).rejects.toThrow("大小限制");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("cancels an oversized stream even when server declares a small size", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_FILE + 1024 * 1024 + 1));
        },
        cancel,
      }),
      { headers: { "content-length": "1" } },
    );
    await expect(readOriginalArchive(response, new AbortController().signal)).rejects.toThrow("大小限制");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("cancels a stalled download when the user stops", async () => {
    const cancel = vi.fn();
    const abort = new AbortController();
    const response = new Response(new ReadableStream({ cancel }));
    const promise = readOriginalArchive(response, abort.signal);
    abort.abort();
    await expect(promise).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("clears queued original bytes and notes without saving or deleting records", async () => {
    render(<BatchImport onSaved={vi.fn()} userName="users/alice" />);
    fireEvent.change(screen.getByLabelText("批量资料文件"), { target: { files: [file("private.txt")] } });
    fireEvent.change(screen.getByLabelText("批量共同批注"), { target: { value: "private note" } });
    fireEvent.click(screen.getByRole("button", { name: "预检这批资料" }));
    await screen.findByText("已预检，尚未保存");
    fireEvent.click(screen.getByRole("button", { name: "清空本页队列" }));
    expect(screen.queryByText(/private.txt/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("批量共同批注")).toHaveValue("");
    expect(createMemo).not.toHaveBeenCalled();
    expect(createAttachment).not.toHaveBeenCalled();
  });
});

describe("private local import receipts", () => {
  it("never copies source content or notes into the receipt", async () => {
    const items = await prepareBatch([file("a.txt", "secret original")], "diary", "secret note", "users/alice");
    const receipt = buildBatchReceipt(items, { [items[0].id]: "imported" });
    expect(receipt.items[0]).toMatchObject({ filename: "a.txt", status: "imported", sha256: items[0].sha256 });
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain("secret original");
    expect(serialized).not.toContain("secret note");
    expect(serialized).not.toContain("users/alice");
  });
  it("does not present pending or uncertain writes as completed", async () => {
    const items = await prepareBatch([file("a.txt"), file("b.txt"), file("c.txt")], "reference", "", "users/alice");
    const receipt = buildBatchReceipt(items, { [items[0].id]: "saving", [items[1].id]: "review" });
    expect(receipt.items.map((item) => item.status)).toEqual(["needs-review", "needs-review", "not-started"]);
  });
});

describe("explicit Chinese text encoding", () => {
  const legacy = {
    name: "legacy.txt",
    type: "text/plain",
    size: 4,
    arrayBuffer: async () => new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]).buffer,
  } as File;
  it("rejects invalid default decoding before network and preserves original bytes with explicit GB18030", async () => {
    await expect(prepareBatch([legacy], "reference", "", "users/alice")).rejects.toThrow("utf-8");
    const item = (await prepareBatch([legacy], "reference", "", "users/alice", "gb18030"))[0];
    expect(item.content).toContain("中文");
    expect(item.content).toContain("文本解码：gb18030");
    expect(Array.from(item.data)).toEqual([0xd6, 0xd0, 0xce, 0xc4]);
    expect(createAttachment).not.toHaveBeenCalled();
  });
  it("retains legacy default identities and separates explicit text interpretations", async () => {
    const text = file("a.txt", "ASCII");
    const defaultItem = (await prepareBatch([text], "work", "", "users/alice"))[0];
    const explicit = (await prepareBatch([text], "work", "", "users/alice", "utf-8"))[0];
    const gb = (await prepareBatch([text], "work", "", "users/alice", "gb18030"))[0];
    expect(defaultItem).toEqual(explicit);
    expect(gb.id).not.toBe(defaultItem.id);
    const binary = file("a.bin");
    const a = (await prepareBatch([binary], "work", "", "users/alice"))[0];
    const b = (await prepareBatch([binary], "work", "", "users/alice", "gb18030"))[0];
    expect(a).toEqual(b);
  });
  it("lets the user inspect decoded Chinese before saving", async () => {
    render(<BatchImport onSaved={vi.fn()} userName="users/alice" />);
    fireEvent.change(screen.getByLabelText("批量资料文件"), { target: { files: [legacy] } });
    fireEvent.change(screen.getByLabelText("文本编码"), { target: { value: "gb18030" } });
    fireEvent.click(screen.getByRole("button", { name: "预检这批资料" }));
    await screen.findByText("已预检，尚未保存");
    expect(screen.getByText(/文本解码：gb18030/)).toHaveTextContent("中文");
    expect(createMemo).not.toHaveBeenCalled();
  });
});

describe("server memo quota preflight", () => {
  it("rejects final UTF-8 body bytes before attachment upload", async () => {
    const item = (await prepareBatch([file("large.txt", "合成测试材料。".repeat(1000))], "reference", "", "users/alice"))[0];
    await expect(ingestBatchSource(item, new AbortController().signal)).rejects.toThrow("8192");
    expect(createAttachment).not.toHaveBeenCalled();
    expect(createMemo).not.toHaveBeenCalled();
  });
  it("fails closed when current quota cannot be read", async () => {
    getUserUsage.mockRejectedValue(new Error("secret provider detail"));
    const items = await prepareBatch([file("a.txt")], "reference", "", "users/alice");
    await expect(validateBatchQuota(items)).rejects.toThrow("尚未上传");
    await expect(ingestBatchSource(items[0], new AbortController().signal)).rejects.toThrow("尚未上传");
    expect(createAttachment).not.toHaveBeenCalled();
  });
  it("honors explicit unlimited quota and rechecks changed quota on save", async () => {
    const items = await prepareBatch([file("a.txt")], "reference", "", "users/alice");
    getUserUsage.mockResolvedValue({ limits: { memoContentBytes: 0n } });
    await validateBatchQuota(items);
    getUserUsage.mockResolvedValue({ limits: { memoContentBytes: 1n } });
    await expect(ingestBatchSource(items[0], new AbortController().signal)).rejects.toThrow("上限 1");
    expect(createAttachment).not.toHaveBeenCalled();
  });
});

describe("explicit long text UI", () => {
  it("preserves all unicode and BOM, account identities and source links", async () => {
    const text = "\ufeff" + "中文😀\r\n".repeat(1200);
    const a = await prepareLongBatch([file("long.txt", text)], "diary", "note", "users/alice");
    const b = await prepareLongBatch([file("long.txt", text)], "diary", "note", "users/bob");
    expect(a[0].id).not.toBe(b[0].id);
    expect(
      a
        .slice(1)
        .map((x) => x.content.split("## 分段原文\n")[1])
        .join(""),
    ).toBe(text);
    expect(a[1].content).toContain(`/memos/${a[0].id}`);
    expect(a[0].content).toContain(`/memos/${a[1].id}`);
    expect(Array.from(a[0].data)).toEqual(Array.from(new TextEncoder().encode(text)));
    await validateBatchQuota(a);
  });
  it("rejects unsupported and oversized input without writes", async () => {
    await expect(prepareLongBatch([file("x.json")], "reference", "", "users/alice")).rejects.toThrow();
    await expect(prepareLongBatch([file("x.txt", "a".repeat(262145))], "reference", "", "users/alice")).rejects.toThrow();
    expect(createAttachment).not.toHaveBeenCalled();
  });
  it("requires explicit confirmation and shows partial progress after failed part", async () => {
    render(<BatchImport onSaved={vi.fn()} userName="users/alice" />);
    fireEvent.click(screen.getByLabelText(/长文分段模式/));
    fireEvent.change(screen.getByLabelText("批量资料文件"), { target: { files: [file("x.txt", "字".repeat(3000))] } });
    fireEvent.click(screen.getByRole("button", { name: "预检这批资料" }));
    const confirm = await screen.findByLabelText(/我确认保存完整原件/);
    const save = screen.getByRole("button", { name: "保存为私有记录 / 复核重试" });
    expect(save).toBeDisabled();
    expect(createMemo).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    createMemo.mockResolvedValueOnce({ name: "memos/index" }).mockRejectedValueOnce(new Error("synthetic"));
    fireEvent.click(save);
    await screen.findByText("需检查");
    expect(screen.getByText(/部分完成或状态待核对/)).toHaveTextContent("1/4");
    expect(createMemo).toHaveBeenCalledTimes(2);
    expect(createMemo.mock.calls[0][0].memo.visibility).toBe(Visibility.PRIVATE);
    expect(createMemo.mock.calls[1][0].memo.visibility).toBe(Visibility.PRIVATE);
  });
});

describe("cross-entry duplicate guard", () => {
  it("blocks CLI source before attachments and scopes every page to owner", async () => {
    const [item] = await prepareBatch([file("a.txt")], "reference", "", "users/alice");
    listMemos
      .mockResolvedValueOnce({ memos: [], nextPageToken: "next" })
      .mockResolvedValueOnce({ memos: [{ name: "memos/mw-other" }], nextPageToken: "" });
    await expect(ingestBatchSource(item, new AbortController().signal)).rejects.toThrow("另一入口");
    expect(createAttachment).not.toHaveBeenCalled();
    expect(listMemos.mock.calls[1][0]).toMatchObject({ pageToken: "next" });
    expect(listMemos.mock.calls[0][0].filter).toContain('creator == "users/alice"');
  });
  it("fails closed on lookup failure but skips long child fragments", async () => {
    const [item] = await prepareBatch([file("a.txt")], "reference", "", "users/alice");
    listMemos.mockRejectedValue(new Error("private provider detail"));
    await expect(checkOtherEntry(item)).rejects.toThrow("尚未上传");
    await expect(checkOtherEntry({ ...item, id: "muc-child" })).resolves.toBeUndefined();
  });
  it.skipIf(!process.env.MOTEARY_CROSS_QA)("uses actual REST service to stop UI import after CLI original", async () => {
    const fixture = JSON.parse(process.env.MOTEARY_CROSS_QA!);
    listMemos.mockImplementation(async (query) => {
      const params = new URLSearchParams({ filter: query.filter, pageSize: String(query.pageSize), pageToken: query.pageToken });
      const response = await fetch(`${fixture.base}/api/memos?${params}`, { headers: { Authorization: `Bearer ${fixture.token}` } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      return { memos: result.memos ?? [], nextPageToken: result.nextPageToken ?? "" };
    });
    const [item] = await prepareBatch([file("a.txt")], "reference", "", fixture.owner);
    item.sha256 = fixture.sha256;
    await expect(checkOtherEntry(item)).rejects.toThrow("另一入口");
    expect(createAttachment).not.toHaveBeenCalled();
  });
});

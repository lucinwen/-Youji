import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveAudio } from "@/components/MotearyWorkspace/audioImport";
import type { BatchSource } from "@/components/MotearyWorkspace/batchImport";

const rpc = vi.hoisted(() => ({ getCurrentUser: vi.fn(), oldUpload: vi.fn() }));
vi.mock("@/connect", () => ({
  authServiceClient: { getCurrentUser: rpc.getCurrentUser },
  attachmentServiceClient: { createAttachment: rpc.oldUpload },
}));
vi.mock("@/auth-state", () => ({ getAccessToken: () => "synthetic-token" }));
const owner = "users/synthetic";
const fetchMock = vi.fn();
const plan = (size?: number): { item: BatchSource } => ({
  item: {
    owner,
    id: `mwa-${"a".repeat(30)}`,
    filename: "合成音频.wav",
    data: new Uint8Array(size ?? 256).fill(255),
    sha256: "b".repeat(64),
    content: "#拾微\n#source/conversation\n合成聊天正文",
  },
});
const signal = () => new AbortController().signal;
beforeEach(() => {
  fetchMock.mockReset();
  rpc.getCurrentUser.mockReset();
  rpc.oldUpload.mockReset();
  rpc.getCurrentUser.mockResolvedValue({ user: { name: owner } });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  expect(rpc.oldUpload).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
describe("audio binary atomic original client", () => {
  it("sends only one authenticated audio binary endpoint request with exact raw bytes", async () => {
    const value = plan();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          memo: `memos/${value.item.id}`,
          attachment: "attachments/yma-synthetic",
          sha256: value.item.sha256,
          status: "imported",
        }),
      ),
    );
    const receipt = vi.fn();
    expect((await saveAudio(value.item, signal(), receipt)).status).toBe("imported");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/youji/audio-original/import");
    expect(options).toEqual(expect.objectContaining({ credentials: "same-origin", cache: "no-store", redirect: "error" }));
    const body = JSON.parse(options.body);
    expect(body.owner).toBe(owner);
    expect(Object.keys(body).sort()).toEqual(["content", "data", "filename", "owner"]);
    expect([...Buffer.from(body.data, "base64")]).toEqual([...value.item.data]);
    expect(receipt.mock.calls.map(([r]) => r.status)).toEqual(["prepared", "save-unknown", "imported"]);
  });
  it("allows the audio binary 16 MiB limit without widening manual text limits", async () => {
    const value = plan(16 * 1024 * 1024);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          memo: `memos/${value.item.id}`,
          attachment: "attachments/yma-synthetic",
          sha256: value.item.sha256,
          status: "verified",
        }),
      ),
    );
    expect((await saveAudio(value.item, signal(), vi.fn())).status).toBe("verified");
    fetchMock.mockClear();
    await expect(saveAudio(plan(16 * 1024 * 1024 + 1).item, signal(), vi.fn())).rejects.toThrow("大小限制");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects account changes before any POST", async () => {
    rpc.getCurrentUser.mockResolvedValue({ user: { name: "users/other" } });
    await expect(saveAudio(plan().item, signal(), vi.fn())).rejects.toThrow("账户已变化");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([404, 501, 409])("does not fall back when audio binary endpoint returns %s", async (status) => {
    fetchMock.mockResolvedValue(new Response("ignored", { status }));
    await expect(saveAudio(plan().item, signal(), vi.fn())).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/youji/audio-original/import");
  });
  it("keeps uncertain outcome when a completed response is unavailable", async () => {
    fetchMock.mockRejectedValue(new Error("synthetic response loss"));
    const receipt = vi.fn();
    await expect(saveAudio(plan().item, signal(), receipt)).rejects.toThrow("结果未知");
    expect(receipt.mock.calls.map(([r]) => r.status)).toEqual(["prepared", "save-unknown"]);
  });
});

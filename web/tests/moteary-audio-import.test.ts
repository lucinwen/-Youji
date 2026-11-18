import { webcrypto } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { zipSync } from "fflate";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { audioWithTranscript, prepareAudio, saveAudio, transcribeAudio } from "@/components/MotearyWorkspace/audioImport";
import { getOriginalAudio } from "@/components/MotearyWorkspace/OriginalAudioPreview";
import { MemoSchema, Visibility } from "@/types/proto/api/memo_service_pb";

const rpc = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getUserUsage: vi.fn(),
  getMemo: vi.fn(),
  createMemo: vi.fn(),
  listAttachments: vi.fn(),
  createAttachment: vi.fn(),
  getAttachment: vi.fn(),
}));
vi.mock("@/connect", () => ({
  authServiceClient: { getCurrentUser: rpc.getCurrentUser },
  userServiceClient: { getUserUsage: rpc.getUserUsage },
  memoServiceClient: { getMemo: rpc.getMemo, createMemo: rpc.createMemo },
  attachmentServiceClient: {
    listAttachments: rpc.listAttachments,
    createAttachment: rpc.createAttachment,
    getAttachment: rpc.getAttachment,
  },
}));
vi.mock("@/auth-state", () => ({ getAccessToken: () => null }));
const data = new TextEncoder().encode("synthetic audio unit fixture");
const file = { name: "synthetic.wav", size: data.length, arrayBuffer: async () => new Uint8Array(data).buffer } as File;
const owner = "users/synthetic";
const attachment = { name: "attachments/synthetic", creator: owner, filename: "synthetic.wav.original.zip", memo: "", externalLink: "" };
const signal = () => new AbortController().signal;
const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", fetchMock);
  for (const fn of Object.values(rpc)) fn.mockReset();
  rpc.getCurrentUser.mockResolvedValue({ user: { name: owner } });
  rpc.getUserUsage.mockResolvedValue({ limits: { memoContentBytes: 100000n } });
  rpc.getMemo.mockRejectedValue(new ConnectError("missing", Code.NotFound));
  rpc.listAttachments.mockResolvedValue({ attachments: [], nextPageToken: "" });
  rpc.createAttachment.mockResolvedValue(attachment);
  rpc.getAttachment.mockResolvedValue(attachment);
  rpc.createMemo.mockResolvedValue({});
  fetchMock
    .mockReset()
    .mockImplementation(async () => new Response(new Uint8Array(zipSync({ [file.name]: new Uint8Array(data) }, { level: 0 })).buffer));
});
afterEach(() => vi.unstubAllGlobals());
it("uses stable audio identity across transcript edits and stores one private original with literal drafts", async () => {
  const original = await prepareAudio(file, owner);
  const one = audioWithTranscript(original, "人工核对 <img src=x> #source/link");
  const two = audioWithTranscript(original, "different text");
  expect(one.id).toBe(two.id);
  expect(one.content).toContain("#source/podcast");
  const receipts = vi.fn();
  const result = await saveAudio(one, signal(), receipts);
  expect(result.status).toBe("imported");
  expect(rpc.createMemo).toHaveBeenCalledOnce();
  expect(rpc.createMemo.mock.calls[0][0].memo.visibility).toBe(Visibility.PRIVATE);
  expect(rpc.createAttachment.mock.calls[0][0].attachment.filename).toBe("synthetic.wav.original.zip");
  expect(getOriginalAudio(create(MemoSchema, { content: one.content, attachments: [attachment] }))).toEqual(
    expect.objectContaining({ filename: file.name, sha256: one.sha256, type: "audio/wav" }),
  );
  expect(receipts.mock.calls.map(([receipt]) => receipt.status)).toEqual([
    "prepared",
    "upload-unknown",
    "uploaded",
    "save-unknown",
    "imported",
  ]);
});
it("verifies duplicates but rejects altered existing transcript without overwriting", async () => {
  const item = audioWithTranscript(await prepareAudio(file, owner), "人工稿");
  rpc.getMemo.mockResolvedValue({ creator: owner, visibility: Visibility.PRIVATE, content: item.content, attachments: [attachment] });
  expect((await saveAudio(item, signal(), vi.fn())).status).toBe("verified");
  await expect(saveAudio(audioWithTranscript(item, "changed"), signal(), vi.fn())).rejects.toThrow("不会覆盖或另建");
  expect(rpc.createMemo).not.toHaveBeenCalled();
  expect(rpc.createAttachment).not.toHaveBeenCalled();
});
it("keeps an unknown-upload receipt and reuses a byte-verified orphan on retry", async () => {
  const item = audioWithTranscript(await prepareAudio(file, owner), "人工稿");
  rpc.createAttachment.mockRejectedValueOnce(new Error("lost response"));
  const receipts = vi.fn();
  await expect(saveAudio(item, signal(), receipts)).rejects.toThrow("上传结果未知");
  expect(receipts.mock.lastCall?.[0]).toEqual(
    expect.objectContaining({ memo: `memos/${item.id}`, sha256: item.sha256, status: "upload-unknown" }),
  );
  rpc.listAttachments.mockResolvedValue({ attachments: [attachment], nextPageToken: "" });
  expect((await saveAudio(item, signal(), vi.fn())).status).toBe("imported");
  expect(rpc.createAttachment).toHaveBeenCalledOnce();
});
it("refuses changed account before memo write and reports the uploaded attachment", async () => {
  const item = audioWithTranscript(await prepareAudio(file, owner), "人工稿");
  rpc.getCurrentUser
    .mockResolvedValueOnce({ user: { name: owner } })
    .mockResolvedValueOnce({ user: { name: owner } })
    .mockResolvedValueOnce({ user: { name: owner } })
    .mockResolvedValue({ user: { name: "users/other" } });
  const receipts = vi.fn();
  await expect(saveAudio(item, signal(), receipts)).rejects.toThrow("账户已变化");
  expect(rpc.createMemo).not.toHaveBeenCalled();
  expect(receipts.mock.lastCall?.[0].attachment).toBe(attachment.name);
});
it("does not reuse attached or duplicate orphan candidates", async () => {
  const item = audioWithTranscript(await prepareAudio(file, owner), "人工稿");
  rpc.listAttachments.mockResolvedValue({ attachments: [attachment, { ...attachment, name: "attachments/second" }], nextPageToken: "" });
  await expect(saveAudio(item, signal(), vi.fn())).rejects.toThrow("多个未关联原件");
  expect(rpc.createMemo).not.toHaveBeenCalled();
});
it("leaves manual import available when a model is unavailable and rejects mismatched transcription hashes", async () => {
  const item = await prepareAudio(file, owner);
  fetchMock.mockResolvedValueOnce(new Response("{}", { status: 503 }));
  await expect(transcribeAudio(item, signal())).rejects.toThrow("可粘贴人工转写稿");
  expect(fetchMock).toHaveBeenCalledOnce();
  fetchMock
    .mockResolvedValueOnce(new Response(JSON.stringify({ available: true })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ sha256: "wrong", engine: "faster-whisper" })));
  await expect(transcribeAudio(item, signal())).rejects.toThrow("校验失败");
  expect(rpc.createMemo).not.toHaveBeenCalled();
});
it("rejects oversized originals and plaintext before uploads rather than truncating them", async () => {
  await expect(prepareAudio({ ...file, size: 16 * 1024 * 1024 + 1 } as File, owner)).rejects.toThrow("16 MiB");
  const item = await prepareAudio(file, owner);
  expect(() => audioWithTranscript(item, "字".repeat(100000))).toThrow("256 KiB");
  expect(rpc.createAttachment).not.toHaveBeenCalled();
});

it("prepares a bounded transcript with many code markers without spreading arguments", async () => {
  const original = await prepareAudio(file, owner);
  const text = "`a".repeat(130000);
  expect(audioWithTranscript(original, text).content).toContain(text);
  expect(rpc.createAttachment).not.toHaveBeenCalled();
});

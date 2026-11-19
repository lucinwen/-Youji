import { webcrypto } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { zipSync } from "fflate";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  audioWithTranscript,
  encodeAudioDraft,
  prepareAudio,
  restoreAudioDraft,
  transcribeAudio,
} from "@/components/MotearyWorkspace/audioImport";
import { getOriginalAudio } from "@/components/MotearyWorkspace/OriginalAudioPreview";
import { MemoSchema } from "@/types/proto/api/memo_service_pb";

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
  expect(getOriginalAudio(create(MemoSchema, { content: one.content, attachments: [attachment] }))).toEqual(
    expect.objectContaining({ filename: file.name, sha256: one.sha256, type: "audio/wav" }),
  );
});
it.each([
  ".hidden.wav",
  " spaced.wav",
  "bad\x7f.wav",
  `${"a".repeat(240)}.wav`,
])("rejects invalid original filename %s before upload", async (name) => {
  await expect(prepareAudio({ ...file, name } as File, owner)).rejects.toThrow("文件名有效");
  expect(fetchMock).not.toHaveBeenCalled();
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

const draftFile = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  return { name: "draft.json", size: bytes.length, arrayBuffer: async () => new Uint8Array(bytes).buffer } as File;
};
const transcript = (sha256: string) => ({
  sha256,
  engine: "faster-whisper",
  model: "Systran/faster-whisper-tiny",
  revision: "a".repeat(40),
  language: "zh",
  duration: 3,
  segments: [{ start: 0, end: 2, text: "<img src=x>机器稿" }],
  text: "<img src=x>机器稿",
});

it("accepts the existing bounded server transcript contract through the shared validator", async () => {
  const item = await prepareAudio(file, owner);
  const machine = transcript(item.sha256);
  fetchMock
    .mockResolvedValueOnce(new Response(JSON.stringify({ available: true })))
    .mockResolvedValueOnce(new Response(JSON.stringify(machine)));
  expect(await transcribeAudio(item, signal())).toEqual(machine);
  expect(audioWithTranscript(item, "人工核对", machine).content).toContain(machine.revision);
  expect(rpc.createMemo).not.toHaveBeenCalled();
});

it.each([
  false,
  true,
])("round-trips a sensitive local draft with machine=%s without audio bytes or any network call", async (withMachine) => {
  const item = await prepareAudio(file, owner);
  const machine = withMachine ? transcript(item.sha256) : undefined;
  const encoded = encodeAudioDraft(item, "人工核对中文\n<script>literal</script>", machine);
  const restored = await restoreAudioDraft(draftFile(encoded), item);
  expect(restored.edited).toBe("人工核对中文\n<script>literal</script>");
  expect(restored.machine).toEqual(machine);
  expect(restored.source).toEqual({ owner, filename: file.name, sha256: item.sha256 });
  expect(encoded).not.toContain("synthetic audio unit fixture");
  expect(encoded).not.toContain('"data"');
  expect(encoded).not.toContain('"attachments"');
  expect(fetchMock).not.toHaveBeenCalled();
  expect(rpc.getCurrentUser).not.toHaveBeenCalled();
  expect(rpc.createMemo).not.toHaveBeenCalled();
});
it.each(["owner", "filename", "sha256"])("rejects a draft with mismatched source %s", async (field) => {
  const item = await prepareAudio(file, owner);
  const draft = JSON.parse(encodeAudioDraft(item, "draft"));
  draft.source[field] = "different";
  await expect(restoreAudioDraft(draftFile(JSON.stringify(draft)), item)).rejects.toThrow("不匹配");
});
it.each([
  { version: 2 },
  { format: "receipt" },
  { edited: 1 },
  { extra: "not allowed" },
  { machine: null },
  { edited: "字".repeat(100000) },
])("rejects unsupported or malformed draft schema %#", async (patch) => {
  const item = await prepareAudio(file, owner);
  const draft = { ...JSON.parse(encodeAudioDraft(item, "draft")), ...patch };
  await expect(restoreAudioDraft(draftFile(JSON.stringify(draft)), item)).rejects.toThrow();
});
it.each([
  { model: "unverified-model" },
  { revision: "not-a-commit" },
  { duration: 121 },
  { language: "unknown" },
  { text: "字".repeat(30000) },
  { segments: Array.from({ length: 1001 }, () => ({ start: 0, end: 1, text: "x" })) },
  { segments: [{ start: -1, end: 1, text: "x" }] },
  { segments: [{ start: 0, end: 8, text: "x" }] },
  {
    segments: [
      { start: 2, end: 2, text: "x" },
      { start: 1, end: 2, text: "y" },
    ],
  },
  { segments: [{ start: 0, end: 2, text: "x", html: "not allowed" }] },
  { text: "does not match segments" },
])("shares bounded machine validation for restore and save %#", async (patch) => {
  const item = await prepareAudio(file, owner);
  const machine = { ...transcript(item.sha256), ...patch };
  const draft = { ...JSON.parse(encodeAudioDraft(item, "draft")), machine };
  await expect(restoreAudioDraft(draftFile(JSON.stringify(draft)), item)).rejects.toThrow("校验失败");
  expect(() => audioWithTranscript(item, "human", machine)).toThrow("校验失败");
});
it("rejects actual oversized bytes, invalid UTF-8 and invalid JSON without network", async () => {
  const item = await prepareAudio(file, owner);
  await expect(
    restoreAudioDraft({ size: 1, arrayBuffer: async () => new Uint8Array(1024 * 1024 + 1).buffer } as File, item),
  ).rejects.toThrow("1 MiB");
  await expect(restoreAudioDraft({ size: 1, arrayBuffer: async () => new Uint8Array([255]).buffer } as File, item)).rejects.toThrow(
    "UTF-8 JSON",
  );
  await expect(restoreAudioDraft(draftFile("{unfinished"), item)).rejects.toThrow("UTF-8 JSON");
  expect(fetchMock).not.toHaveBeenCalled();
});

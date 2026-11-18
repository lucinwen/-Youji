import { Code, ConnectError } from "@connectrpc/connect";
import { zipSync } from "fflate";
import { getAccessToken } from "@/auth-state";
import { attachmentServiceClient, authServiceClient, memoServiceClient } from "@/connect";
import type { Attachment } from "@/types/proto/api/attachment_service_pb";
import { Visibility } from "@/types/proto/api/memo_service_pb";
import { type BatchSource, MAX_FILE, readOriginalArchive, validateBatchQuota, verifyOriginalArchive } from "./batchImport";

export type AudioTranscript = {
  sha256: string;
  engine: string;
  model: string;
  revision: string;
  language: string;
  duration: number;
  segments: { start: number; end: number; text: string }[];
  text: string;
};
export type AudioReceipt = {
  memo: string;
  filename: string;
  sha256: string;
  archive: string;
  attachment?: string;
  status: "prepared" | "upload-unknown" | "uploaded" | "save-unknown" | "imported" | "verified";
};
export type AudioDraft = {
  format: "youji-audio-draft";
  version: 1;
  source: { owner: string; filename: string; sha256: string };
  edited: string;
  machine?: AudioTranscript;
};
const MAX_DRAFT = 1024 * 1024;
const objectWithKeys = (value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key));

// Shared by server responses, draft restore and save. Shape validation is not proof of model provenance.
function validateTranscript(value: unknown, sha256: string): AudioTranscript {
  const invalid = () => new Error("转写来源、时间或正文校验失败，未保存。");
  if (!objectWithKeys(value, ["sha256", "engine", "model", "revision", "language", "duration", "segments", "text"])) throw invalid();
  if (
    value.sha256 !== sha256 ||
    value.engine !== "faster-whisper" ||
    typeof value.model !== "string" ||
    !/^Systran\/faster-whisper-(tiny|base|small)$/.test(value.model) ||
    typeof value.revision !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.revision) ||
    value.language !== "zh" ||
    typeof value.duration !== "number" ||
    !Number.isFinite(value.duration) ||
    value.duration <= 0 ||
    value.duration > 120 ||
    typeof value.text !== "string" ||
    !value.text.trim() ||
    encode(value.text).length > 65536 ||
    !Array.isArray(value.segments) ||
    !value.segments.length ||
    value.segments.length > 1000
  )
    throw invalid();
  let previous = 0;
  let size = 0;
  const segments = value.segments.map((segment: unknown) => {
    if (
      !objectWithKeys(segment, ["start", "end", "text"]) ||
      typeof segment.start !== "number" ||
      typeof segment.end !== "number" ||
      !Number.isFinite(segment.start) ||
      !Number.isFinite(segment.end) ||
      segment.start < previous ||
      segment.end < segment.start ||
      segment.end > (value.duration as number) + 1 ||
      typeof segment.text !== "string" ||
      !segment.text.trim()
    )
      throw invalid();
    previous = segment.start;
    size += encode(segment.text).length;
    if (size > 65536) throw invalid();
    return { start: segment.start, end: segment.end, text: segment.text };
  });
  if (
    segments
      .map((segment) => segment.text)
      .join("")
      .trim() !== value.text
  )
    throw invalid();
  return {
    sha256,
    engine: value.engine,
    model: value.model,
    revision: value.revision,
    language: value.language,
    duration: value.duration,
    segments,
    text: value.text,
  };
}

function validateDraft(value: unknown, item: BatchSource): AudioDraft {
  if (
    !objectWithKeys(value, ["format", "version", "source", "edited"], ["machine"]) ||
    value.format !== "youji-audio-draft" ||
    value.version !== 1 ||
    !objectWithKeys(value.source, ["owner", "filename", "sha256"]) ||
    typeof value.edited !== "string" ||
    encode(value.edited).length > 256 * 1024
  )
    throw new Error("草稿格式或正文大小无效，仅支持有记音频草稿第 1 版。");
  if (value.source.owner !== item.owner || value.source.filename !== item.filename || value.source.sha256 !== item.sha256)
    throw new Error("草稿账户、原文件名或音频 SHA-256 不匹配；请重新选择备份时的同一原音频和账户。");
  const machine = Object.hasOwn(value, "machine") ? validateTranscript(value.machine, item.sha256) : undefined;
  return {
    format: "youji-audio-draft",
    version: 1,
    source: { owner: item.owner, filename: item.filename, sha256: item.sha256 },
    edited: value.edited,
    ...(machine ? { machine } : {}),
  };
}

export function encodeAudioDraft(item: BatchSource, edited: string, machine?: AudioTranscript): string {
  const draft = validateDraft(
    {
      format: "youji-audio-draft",
      version: 1,
      source: { owner: item.owner, filename: item.filename, sha256: item.sha256 },
      edited,
      ...(machine ? { machine } : {}),
    },
    item,
  );
  const text = JSON.stringify(draft, null, 2);
  if (encode(text).length > MAX_DRAFT) throw new Error("草稿 JSON 超过 1 MiB，未下载；请缩短人工稿。");
  return text;
}

export async function restoreAudioDraft(file: File, item: BatchSource): Promise<AudioDraft> {
  if (!file.size || file.size > MAX_DRAFT) throw new Error("草稿 JSON 须非空且不超过 1 MiB。");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_DRAFT) throw new Error("草稿 JSON 须非空且不超过 1 MiB。");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("草稿不是有效的 UTF-8 JSON；原有编辑未修改。");
  }
  return validateDraft(value, item);
}
const encode = (value: string) => new TextEncoder().encode(value);
const hash = async (data: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(data))))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
const fence = (value: string) => {
  let length = 3;
  for (const match of value.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const ticks = "`".repeat(length);
  return `${ticks}\n${value}\n${ticks}`;
};
const archive = (item: BatchSource) => `${item.filename}.original.zip`;
export async function prepareAudio(file: File, owner: string): Promise<BatchSource> {
  if (!/^users\/[a-zA-Z0-9_-]+$/.test(owner)) throw new Error("请先登录。");
  if (
    !/\.(wav|mp3|ogg|m4a|flac|webm)$/i.test(file.name) ||
    /[\\/]/.test(file.name) ||
    Array.from(file.name).some((c) => c.charCodeAt(0) < 32)
  )
    throw new Error("请选择文件名有效的 WAV、MP3、OGG、M4A、FLAC 或 WebM 音频。");
  if (!file.size || file.size > MAX_FILE) throw new Error("音频须非空且不超过 16 MiB。");
  const data = new Uint8Array(await file.arrayBuffer());
  if (!data.length || data.length > MAX_FILE) throw new Error("音频须非空且不超过 16 MiB。");
  const sha256 = await hash(data);
  const id = `mwa-${(await hash(encode(JSON.stringify(["audio-v1", owner, sha256, file.name])))).slice(0, 30)}`;
  return { id, owner, filename: file.name, data, sha256, content: "" };
}
async function account(item: BatchSource, signal: AbortSignal) {
  signal.throwIfAborted();
  const { user } = await authServiceClient.getCurrentUser({}, { signal });
  signal.throwIfAborted();
  if (user?.name !== item.owner) throw new Error("当前账户已变化，请重新选择原件。");
}
async function json(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error("转写服务未返回内容。");
  const reader = response.body.getReader();
  let text = "";
  let size = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1024 * 1024) throw new Error("转写响应超过安全上限。");
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function transcribeAudio(item: BatchSource, signal: AbortSignal): Promise<AudioTranscript> {
  const request = async (path: string, body?: ArrayBuffer) => {
    await account(item, signal);
    const token = getAccessToken();
    return fetch(path, {
      method: body ? "POST" : "GET",
      body,
      signal,
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/octet-stream" } : {}) },
    });
  };
  const errors: Record<number, string> = {
    503: "本地转写模型未配置或校验未通过，可粘贴人工转写稿。",
    429: "本地转写服务正忙，请稍后重试。",
    422: "音频无法转写、无语音或时长超过限制，可使用人工转写稿。",
    504: "本地转写超时，可重试或使用人工稿。",
  };
  const status = await request("/api/youji/audio/processor");
  if (!status.ok) throw new Error(errors[status.status] ?? "无法检查本地转写服务。");
  if (!((await json(status, signal)) as { available?: boolean }).available) throw new Error(errors[503]);
  const response = await request("/api/youji/audio/transcribe", new Uint8Array(item.data).buffer);
  if (!response.ok) throw new Error(errors[response.status] ?? "本地转写失败，可使用人工稿。");
  return validateTranscript(await json(response, signal), item.sha256);
}
export function audioWithTranscript(item: BatchSource, edited: string, machine?: AudioTranscript): BatchSource {
  if (!edited.trim()) throw new Error("请填写并核对人工校订稿。");
  if (encode(edited).length > 256 * 1024) throw new Error("人工稿超过 256 KiB，请缩短后再保存。");
  if (machine) machine = validateTranscript(machine, item.sha256);
  return {
    ...item,
    content: `# 有记音频与校订稿\n\n#拾微 #reference #source/podcast\n\n原文件名：\n${fence(item.filename)}\n\n原件 SHA-256：\`${item.sha256}\`\n原始字节保存在 ZIP。audio-v1；原件、机器稿、人工稿在同一条仅自己可见记录。\n\n## 人工校订稿（用户确认，仍需核对原声）\n${fence(edited)}\n\n## 机器稿（可能严重错误，不代表事实）\n${machine ? `${fence(JSON.stringify({ engine: machine.engine, model: machine.model, revision: machine.revision, language: machine.language, duration: machine.duration }))}\n${fence(machine.text)}\n\n机器分段时间仅供对照，未经准确性验收：\n${fence(machine.segments.map((segment) => `[${segment.start}–${segment.end}s] ${segment.text}`).join("\n"))}` : "未使用自动转写；人工稿由用户提供。"}\n\n删除此记录使用原生删除流程。附件及备份可能残留，请在附件管理核对；不会自动删除其他记录。`,
  };
}
export async function saveAudio(item: BatchSource, signal: AbortSignal, receipt: (value: AudioReceipt) => void): Promise<AudioReceipt> {
  const base: AudioReceipt = {
    memo: `memos/${item.id}`,
    filename: item.filename,
    sha256: item.sha256,
    archive: archive(item),
    status: "prepared",
  };
  receipt(base);
  await account(item, signal);
  const verify = async (attachment: Attachment) => {
    if (
      attachment.creator !== item.owner ||
      attachment.externalLink ||
      attachment.filename !== archive(item) ||
      !/^attachments\/[a-zA-Z0-9-]+$/.test(attachment.name)
    )
      throw new Error("原件附件归属不符。");
    await account(item, signal);
    const token = getAccessToken();
    const response = await fetch(`/file/${attachment.name}/${encodeURIComponent(attachment.filename)}`, {
      signal,
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) throw new Error("无法下载核验原件。");
    await verifyOriginalArchive(await readOriginalArchive(response, signal), item.filename, item.sha256);
  };
  try {
    const memo = await memoServiceClient.getMemo({ name: base.memo }, { signal });
    if (
      memo.creator !== item.owner ||
      memo.visibility !== Visibility.PRIVATE ||
      memo.content !== item.content ||
      memo.attachments.length !== 1
    )
      throw new Error("同一原件的已有记录或稿件已变化，请打开已有记录人工编辑；不会覆盖或另建记录。");
    await verify(memo.attachments[0]);
    const result = { ...base, attachment: memo.attachments[0].name, status: "verified" as const };
    receipt(result);
    return result;
  } catch (error) {
    if (!(error instanceof ConnectError && error.code === Code.NotFound)) throw error;
  }
  await validateBatchQuota([item], signal);
  const found = await attachmentServiceClient.listAttachments(
    { filter: `creator == ${JSON.stringify(item.owner)} && filename == ${JSON.stringify(archive(item))}`, pageSize: 20 },
    { signal },
  );
  if (found.nextPageToken || found.attachments.length > 19) throw new Error("同名附件候选过多，请先到附件管理核对。");
  const matches: Attachment[] = [];
  for (const attachment of found.attachments) {
    if (attachment.memo) continue;
    // Fail closed on ambiguous same-name bytes: never claim an unverified upload can be reused.
    await verify(attachment);
    matches.push(attachment);
  }
  if (matches.length > 1)
    throw new Error(`发现多个未关联原件 ${matches.map((entry) => entry.name).join("、")}；请在附件管理核对，不自动删除。`);
  let attachment = matches[0];
  if (!attachment) {
    await account(item, signal);
    receipt({ ...base, status: "upload-unknown" });
    try {
      attachment = await attachmentServiceClient.createAttachment(
        {
          attachment: {
            filename: archive(item),
            type: "application/zip",
            content: zipSync({ [item.filename]: new Uint8Array(item.data) }, { level: 0 }),
          },
        },
        { signal },
      );
    } catch {
      throw new Error("原件上传结果未知。请下载回执；重试会查找并校验同名未关联附件，不会自动删除。");
    }
  }
  receipt({ ...base, attachment: attachment.name, status: "uploaded" });
  const current = await attachmentServiceClient.getAttachment({ name: attachment.name }, { signal });
  if (current.memo) throw new Error("原件已被关联，请重新核验；不会抢占其他记录附件。");
  await verify(current);
  await account(item, signal);
  receipt({ ...base, attachment: current.name, status: "save-unknown" });
  try {
    await memoServiceClient.createMemo(
      { memoId: item.id, memo: { content: item.content, visibility: Visibility.PRIVATE, attachments: [{ name: current.name }] } },
      { signal },
    );
  } catch {
    throw new Error("记录写入结果未知，原件附件已记录在回执中。请重试核验，不要重复新建；不会自动删除。");
  }
  const result = { ...base, attachment: current.name, status: "imported" as const };
  receipt(result);
  return result;
}

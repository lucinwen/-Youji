import { Code, ConnectError } from "@connectrpc/connect";
import { unzipSync, zipSync } from "fflate";
import { getAccessToken } from "@/auth-state";
import { attachmentServiceClient, memoServiceClient, userServiceClient } from "@/connect";
import { Visibility } from "@/types/proto/api/memo_service_pb";
import type { CaptureCategory } from "./sources";

export const MAX_FILE = 16 * 1024 * 1024;
export const MAX_TOTAL = 32 * 1024 * 1024;
export type TextEncoding = "utf-8" | "gb18030";
export interface BatchSource {
  id: string;
  owner: string;
  filename: string;
  data: Uint8Array;
  sha256: string;
  content: string;
}
const hash = async (data: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(data))))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");

export async function prepareBatch(
  files: File[],
  kind: CaptureCategory,
  note: string,
  userName: string,
  textEncoding: TextEncoding = "utf-8",
): Promise<BatchSource[]> {
  if (textEncoding !== "utf-8" && textEncoding !== "gb18030") throw new Error("不支持的文本编码。");
  if (!/^users\/[a-zA-Z0-9_-]+$/.test(userName)) throw new Error("请先登录再导入。");
  if (!files.length || files.length > 32) throw new Error("一次请选择 1–32 个文件。");
  if (files.some((f) => f.size > MAX_FILE) || files.reduce((n, f) => n + f.size, 0) > MAX_TOTAL)
    throw new Error("单文件最多 16 MiB，每批合计最多 32 MiB。");
  if (files.some((f) => !f.name || /[\\/]/.test(f.name) || Array.from(f.name).some((c) => c.charCodeAt(0) < 32)))
    throw new Error("文件名包含不支持的字符。");
  const items: BatchSource[] = [];
  for (const file of files) {
    const data = new Uint8Array(await file.arrayBuffer());
    const sha256 = await hash(data);
    const isText = /\.(md|txt|csv|json)$/i.test(file.name);
    // Keep existing UTF-8 and binary identities stable; explicit legacy decoding is a separate interpretation.
    const identity = [userName, sha256, file.name, kind, note];
    if (isText && textEncoding !== "utf-8") identity.push(textEncoding);
    const id = `mui-${(await hash(new TextEncoder().encode(JSON.stringify(identity)))).slice(0, 30)}`;
    if (items.some((i) => i.id === id)) throw new Error("同一批包含重复文件，请只保留一份。");
    let text = "原件已保存；尚未进行 OCR、转写或 AI 总结。";
    if (isText) {
      try {
        text = new TextDecoder(textEncoding, { fatal: true }).decode(data);
      } catch {
        throw new Error(`${file.name} 无法按 ${textEncoding} 解码。请选择匹配的文本编码后重新预检，原件不会上传。`);
      }
    }
    if (isText && textEncoding !== "utf-8") text = `文本解码：${textEncoding}（用户选择，原始字节保留）\n\n${text}`;
    const source = isText ? "text" : file.type.startsWith("image/") ? "image" : "file";
    const content = `# 拾微原始资料 · ${file.name}\n\n#拾微 #${kind} #source/${source}\n\n## 我的批注\n${note}\n\n## 原始内容\n${text}\n\n---\n原件 SHA-256：\`${sha256}\`\n原始字节保存在 .original.zip；归档可能包含原图 EXIF，请先检查再分享。`;
    items.push({ id, owner: userName, filename: file.name, data, sha256, content });
  }
  return items;
}

// Bound the actual stream, not only Content-Length (which can be absent or false).
export async function readOriginalArchive(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const limit = MAX_FILE + 1024 * 1024;
  const declared = Number(response.headers.get("content-length"));
  if (declared > limit) {
    await response.body?.cancel();
    throw new Error("原件归档超过大小限制，已停止。");
  }
  if (!response.body) throw new Error("原件响应为空，已停止。");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("原件归档超过大小限制，已停止。");
      chunks.push(value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class ImportQuotaError extends Error {}

export async function validateBatchQuota(items: BatchSource[], signal?: AbortSignal): Promise<void> {
  if (!items.length) return;
  const owner = items[0].owner;
  if (!/^users\/[a-zA-Z0-9_-]+$/.test(owner) || items.some((item) => item.owner !== owner))
    throw new ImportQuotaError("无法核对导入账号，本批尚未上传。");
  let usage;
  try {
    usage = await userServiceClient.getUserUsage({ name: `${owner}/usage` }, { signal });
  } catch {
    throw new ImportQuotaError("无法读取当前账号配额，本项尚未上传。请检查登录或连接后重试。");
  }
  if (!usage.limits) throw new ImportQuotaError("服务未返回账号配额，本项尚未上传。");
  const limit = usage.limits.memoContentBytes ?? 0n;
  for (const item of items) {
    const size = new TextEncoder().encode(item.content).length;
    if (limit > 0n && BigInt(size) > limit)
      throw new ImportQuotaError(
        `正文需要 ${size} UTF-8 字节，当前账号上限 ${limit} 字节。本项尚未上传；请拆分长文本或使用原编辑器添加附件。不会截断原文。`,
      );
  }
}

export async function ingestBatchSource(
  item: BatchSource,
  signal: AbortSignal,
): Promise<{ name: string; status: "imported" | "verified" }> {
  const name = `memos/${item.id}`;
  let existing;
  try {
    existing = await memoServiceClient.getMemo({ name }, { signal });
  } catch (error) {
    if (!(error instanceof ConnectError) || error.code !== Code.NotFound) throw error;
  }
  if (existing) {
    if (existing.visibility !== Visibility.PRIVATE || existing.content !== item.content)
      throw new Error("已有记录的正文或权限发生变化，已停止，未覆盖。");
    const original = existing.attachments.find((a) => !a.externalLink && a.filename === `${item.filename}.original.zip`);
    if (!original || !/^attachments\/[a-zA-Z0-9-]+$/.test(original.name)) throw new Error("原件附件缺失，已停止，未重新写入。");
    const token = getAccessToken();
    const response = await fetch(`/file/${original.name}/${encodeURIComponent(original.filename)}`, {
      signal,
      credentials: "same-origin",
      redirect: "error",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) throw new Error("无法读取原件，已停止。");
    const bytes = await readOriginalArchive(response, signal);
    if (bytes.length > MAX_FILE + 1024 * 1024) throw new Error("原件归档异常，已停止。");
    let entryCount = 0;
    const entries = unzipSync(bytes, {
      filter: (f) => {
        entryCount++;
        return f.originalSize <= MAX_FILE;
      },
    });
    if (
      entryCount !== 1 ||
      Object.keys(entries).length !== 1 ||
      !Object.hasOwn(entries, item.filename) ||
      (await hash(entries[item.filename])) !== item.sha256
    )
      throw new Error("原件校验未通过，已停止。");
    return { name, status: "verified" };
  }
  await validateBatchQuota([item], signal);
  const archive = zipSync({ [item.filename]: item.data }, { level: 0 });
  const attachment = await attachmentServiceClient.createAttachment(
    { attachment: { filename: `${item.filename}.original.zip`, type: "application/zip", content: archive } },
    { signal },
  );
  // Never delete uploads after an interrupted request: the memo may have committed.
  const result = await memoServiceClient.createMemo(
    { memoId: item.id, memo: { content: item.content, visibility: Visibility.PRIVATE, attachments: [{ name: attachment.name }] } },
    { signal },
  );
  return { name: result.name, status: "imported" };
}

export type BatchItemState = "saving" | "imported" | "verified" | "review";

/** A local receipt is evidence of UI observations, never a server recovery authority. */
export function buildBatchReceipt(items: BatchSource[], states: Record<string, BatchItemState>) {
  return {
    schema: "moteary-ui-import-receipt-v1",
    warning: "回执不包含正文或批注，但文件名可能敏感。回执不是服务端完成证明；重试仍需核验原件。",
    items: items.map((item) => ({
      filename: item.filename,
      sha256: item.sha256,
      bytes: item.data.length,
      record: `memos/${item.id}`,
      status:
        states[item.id] === "saving" ? "needs-review" : states[item.id] === "review" ? "needs-review" : (states[item.id] ?? "not-started"),
    })),
  };
}

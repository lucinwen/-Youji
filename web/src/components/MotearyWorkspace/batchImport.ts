import { Code, ConnectError } from "@connectrpc/connect";
import { unzipSync, zipSync } from "fflate";
import { getAccessToken } from "@/auth-state";
import { attachmentServiceClient, memoServiceClient } from "@/connect";
import { Visibility } from "@/types/proto/api/memo_service_pb";
import type { CaptureCategory } from "./sources";

export const MAX_FILE = 16 * 1024 * 1024;
export const MAX_TOTAL = 32 * 1024 * 1024;
export interface BatchSource {
  id: string;
  filename: string;
  data: Uint8Array;
  sha256: string;
  content: string;
}
const hash = async (data: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(data))))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");

export async function prepareBatch(files: File[], kind: CaptureCategory, note: string, userName: string): Promise<BatchSource[]> {
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
    const id = `mui-${(await hash(new TextEncoder().encode(JSON.stringify([userName, sha256, file.name, kind, note])))).slice(0, 30)}`;
    if (items.some((i) => i.id === id)) throw new Error("同一批包含重复文件，请只保留一份。");
    const isText = /\.(md|txt|csv|json)$/i.test(file.name);
    let text = "原件已保存；尚未进行 OCR、转写或 AI 总结。";
    if (isText) {
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(data);
      } catch {
        throw new Error(`${file.name} 不是有效 UTF-8 文本，请转换编码后重试。`);
      }
    }
    const source = isText ? "text" : file.type.startsWith("image/") ? "image" : "file";
    const content = `# 拾微原始资料 · ${file.name}\n\n#拾微 #${kind} #source/${source}\n\n## 我的批注\n${note}\n\n## 原始内容\n${text}\n\n---\n原件 SHA-256：\`${sha256}\`\n原始字节保存在 .original.zip；归档可能包含原图 EXIF，请先检查再分享。`;
    items.push({ id, filename: file.name, data, sha256, content });
  }
  return items;
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
    const bytes = new Uint8Array(await response.arrayBuffer());
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

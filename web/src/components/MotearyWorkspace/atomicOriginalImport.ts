import { getAccessToken } from "@/auth-state";
import { authServiceClient } from "@/connect";
import type { AudioReceipt } from "./audioImport";
import type { BatchSource } from "./batchImport";

const bytes = (text: string) => new TextEncoder().encode(text);

/** The dedicated endpoint commits this single original and memo together on supported SQLite servers. Never fall back to multi-request uploads. */
export async function saveAtomicOriginal(
  item: BatchSource,
  kind: "manual" | "html" | "chat" | "audio",
  signal: AbortSignal,
  receipt: (value: AudioReceipt) => void,
): Promise<AudioReceipt> {
  const maximumBytes = kind === "manual" ? 128 * 1024 : kind === "audio" ? 16 * 1024 * 1024 : 512 * 1024;
  const endpoint = {
    manual: "/api/youji/manual-text/import",
    html: "/api/youji/html-text/import",
    chat: "/api/youji/chat-json/import",
    audio: "/api/youji/audio-original/import",
  }[kind];
  signal.throwIfAborted();
  const base: AudioReceipt = {
    memo: `memos/${item.id}`,
    filename: item.filename,
    sha256: item.sha256,
    archive: `${item.filename}.original.zip`,
    status: "prepared",
  };
  receipt(base);
  const { user } = await authServiceClient.getCurrentUser({}, { signal });
  signal.throwIfAborted();
  if (user?.name !== item.owner) throw new Error("当前账户已变化，请重新选择内容；尚未提交保存。");
  if (!item.data.length || item.data.length > maximumBytes || bytes(item.content).length > 256 * 1024)
    throw new Error("文本或保存正文超过大小限制，尚未提交保存。");
  let binary = "";
  for (let offset = 0; offset < item.data.length; offset += 8192)
    binary += String.fromCharCode(...item.data.subarray(offset, offset + 8192));
  const token = getAccessToken();
  receipt({ ...base, status: "save-unknown" });
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      body: JSON.stringify({ owner: item.owner, filename: item.filename, content: item.content, data: btoa(binary) }),
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      signal,
    });
  } catch {
    signal.throwIfAborted();
    throw new Error("保存请求结果未知，请保留回执并重试核验；不会回退旧上传流程。");
  }
  signal.throwIfAborted();
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const errors: Record<number, string> = {
      401: "登录已失效，请重新登录并核对当前账户。",
      403: "当前账户无权保存此内容，请核对登录账户。",
      404: "当前服务器不支持事务文本导入，请更新服务器并使用 SQLite；不会回退旧上传流程。",
      501: "当前服务器不支持事务文本导入，请更新服务器并使用 SQLite；不会回退旧上传流程。",
      409: "已有记录内容冲突或旧版原件不兼容，请打开原记录手动核对；不会覆盖或自动迁移。",
      413: "原文或请求超过服务器大小限制，请缩小文本后重新预览。",
      422: "服务器拒绝输入，请核对原文、文件名、正文和账号正文配额后重新预览。",
      429: "账号配额不足或服务正忙，请检查配额并稍后重试。",
    };
    throw new Error(errors[response.status] ?? "保存未能确认，请保留回执并重试核验；不会回退旧上传流程。");
  }
  if (!response.body) throw new Error("保存响应为空，写入状态未知，请保留回执并重试核验。");
  const reader = response.body.getReader();
  let total = 0;
  let text = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let result: unknown;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 16 * 1024) throw new Error("response too large");
      text += decoder.decode(value, { stream: true });
    }
    result = JSON.parse(text + decoder.decode());
  } catch {
    signal.throwIfAborted();
    throw new Error("保存响应格式或大小异常，写入状态未知，请保留回执并重试核验。");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  signal.throwIfAborted();
  if (
    typeof result !== "object" ||
    result === null ||
    !("memo" in result) ||
    result.memo !== base.memo ||
    !("attachment" in result) ||
    typeof result.attachment !== "string" ||
    !/^attachments\/[a-zA-Z0-9-]+$/.test(result.attachment) ||
    !("status" in result) ||
    (result.status !== "imported" && result.status !== "verified") ||
    !("sha256" in result) ||
    result.sha256 !== item.sha256
  )
    throw new Error("保存回执与原件不匹配，写入状态未知，请保留回执并重试核验。");
  const final: AudioReceipt = { ...base, status: result.status, attachment: result.attachment };
  receipt(final);
  return final;
}

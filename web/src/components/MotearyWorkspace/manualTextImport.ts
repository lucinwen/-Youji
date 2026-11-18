import { getAccessToken } from "@/auth-state";
import { authServiceClient } from "@/connect";
import type { AudioReceipt } from "./audioImport";
import type { BatchSource } from "./batchImport";

export const SOURCES = {
  unspecified: "未注明来源",
  wechat: "微信聊天（手动提供）",
  friends: "朋友对话（手动提供）",
  lecture: "讲座或录音人工稿",
  podcast: "播客人工稿",
  diary: "生活日记",
  work: "工作思考",
  idea: "快速灵感",
} as const;
export type ManualSource = keyof typeof SOURCES;
export type ManualOptions = { source: ManualSource; title: string };
export type ManualTextPlan = { item: BatchSource; text: string; title: string; source: ManualSource };
const control = (text: string, allowWhitespace = false) =>
  Array.from(text).some((c) => {
    const code = c.charCodeAt(0);
    return (code < 32 && !(allowWhitespace && [9, 10, 13].includes(code))) || code === 127;
  });
const bytes = (text: string) => new TextEncoder().encode(text);
const hash = async (data: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(data))))
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
const fence = (text: string) => {
  let length = 3;
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const mark = "`".repeat(length);
  return `${mark}\n${text}\n${mark}`;
};

/** User-provided UTF-8 text only. Never connects to a chat service or reads the clipboard. */
export async function prepareManualText(file: File, owner: string, options: ManualOptions): Promise<ManualTextPlan> {
  if (!/^users\/[a-zA-Z0-9_-]+$/.test(owner)) throw new Error("请先登录。");
  if (!Object.hasOwn(SOURCES, options.source) || typeof options.title !== "string" || options.title.length > 200 || control(options.title))
    throw new Error("来源无效或标题超过 200 字符/含控制字符。");
  if (
    !/\.(txt|md)$/i.test(file.name) ||
    file.name.length > 240 ||
    /[\\/]/.test(file.name) ||
    control(file.name) ||
    file.name.startsWith(".") ||
    file.name.startsWith(" ")
  )
    throw new Error("请选择文件名有效且不以点或空格开头的 TXT 或 Markdown 文本原件。");
  if (!file.size || file.size > 128 * 1024) throw new Error("手动文本须非空且不超过 128 KiB，请分次提供；不会截断保存。");
  if (!crypto.subtle) throw new Error("原件校验需要 HTTPS 或 localhost 安全连接。");
  const data = new Uint8Array(await file.arrayBuffer());
  if (!data.length || data.length > 128 * 1024) throw new Error("文本超过大小限制。");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new Error("原件不是有效 UTF-8，请先另存为 UTF-8 文本；尚未上传。");
  }
  if (!text.trim() || control(text, true)) throw new Error("文本为空或含不支持的控制字符，尚未上传。");
  const sha256 = await hash(data);
  const id = `mwt-${(await hash(bytes(JSON.stringify(["manual-text-v1", owner, sha256, file.name])))).slice(0, 30)}`;
  const source = options.source;
  const kind = source === "wechat" || source === "friends" ? "conversation" : source === "podcast" ? "podcast" : "text";
  const category = source === "diary" || source === "work" || source === "idea" ? source : "reference";
  const title = options.title.trim() || file.name;
  const content = `# 有记手动文本\n\n#拾微 #${category} #source/${kind}\n\n## 标题、来源与原文件名（用户提供）\n${fence(`${title}\n${SOURCES[source]}\n${file.name}`)}\n\n原件 SHA-256：${sha256}\nmanual-text-v1；未连接微信或其他平台；未验证发言人、时间或内容真实性，未自动转写。Markdown、链接与 HTML 均作为文字。\n\n## 原文（可用关键词找回）\n${fence(text)}\n\n原始 UTF-8 字节保存在 .original.zip，可下载核对。粘贴输入保存的是预览时文本快照，不是平台导出或媒体备份。删除请使用记录删除并核对附件与外部备份。`;
  if (bytes(content).length > 256 * 1024) throw new Error("保存正文超过 256 KiB，请缩小文本；不会截断。");
  return { item: { id, owner, filename: file.name, data, sha256, content }, text, title, source };
}

export async function preparePastedText(text: string, owner: string, options: ManualOptions): Promise<ManualTextPlan> {
  const data = bytes(text);
  if (!data.length || data.length > 128 * 1024) throw new Error("粘贴文本须非空且不超过 128 KiB。");
  if (!crypto.subtle) throw new Error("原件校验需要 HTTPS 或 localhost 安全连接。");
  const filename = `手动文本-${(await hash(data)).slice(0, 12)}.txt`;
  return prepareManualText(new File([data], filename, { type: "text/plain" }), owner, options);
}

/** The dedicated endpoint commits this single original and memo together on supported SQLite servers. Never fall back to multi-request uploads. */
export async function saveManualText(
  plan: ManualTextPlan,
  signal: AbortSignal,
  receipt: (value: AudioReceipt) => void,
): Promise<AudioReceipt> {
  const item = plan.item;
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
  if (!item.data.length || item.data.length > 128 * 1024 || bytes(item.content).length > 256 * 1024)
    throw new Error("文本或保存正文超过大小限制，尚未提交保存。");
  let binary = "";
  for (let offset = 0; offset < item.data.length; offset += 8192)
    binary += String.fromCharCode(...item.data.subarray(offset, offset + 8192));
  const token = getAccessToken();
  receipt({ ...base, status: "save-unknown" });
  let response: Response;
  try {
    response = await fetch("/api/youji/manual-text/import", {
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

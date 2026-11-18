import { type AudioReceipt, saveAudio } from "./audioImport";
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
  if (!/\.(txt|md)$/i.test(file.name) || file.name.length > 240 || /[\\/]/.test(file.name) || control(file.name))
    throw new Error("请选择文件名有效的 TXT 或 Markdown 文本原件。");
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

export const saveManualText = (plan: ManualTextPlan, signal: AbortSignal, receipt: (value: AudioReceipt) => void) =>
  saveAudio(plan.item, signal, receipt);

import { type AudioReceipt, saveAudio } from "./audioImport";
import type { BatchSource } from "./batchImport";

export type ChatPlan = { item: BatchSource; title: string; transcript: string; messages: number; service: number; media: number };
const bytes = (text: string) => new TextEncoder().encode(text);
const hash = async (value: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(value))))
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown, max = 2048): value is string => typeof value === "string" && value.length <= max;
const fence = (text: string) => {
  let length = 3;
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const mark = "`".repeat(length);
  return `${mark}\n${text}\n${mark}`;
};

/** A bounded subset of Telegram Desktop's single-chat JSON. No DOM, links or media are loaded. */
export async function prepareChat(file: File, owner: string): Promise<ChatPlan> {
  if (!/^users\/[a-zA-Z0-9_-]+$/.test(owner)) throw new Error("请先登录。");
  if (
    !/\.json$/i.test(file.name) ||
    file.name.length > 240 ||
    /[\\/]/.test(file.name) ||
    Array.from(file.name).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new Error("请选择文件名有效的 JSON 原件。");
  if (!file.size || file.size > 512 * 1024) throw new Error("聊天 JSON 须非空且不超过 512 KiB，请在导出时缩小日期范围。");
  const data = new Uint8Array(await file.arrayBuffer());
  if (!data.length || data.length > 512 * 1024) throw new Error("聊天 JSON 超过大小限制。");
  let source: unknown;
  try {
    source = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch {
    throw new Error("原件不是有效 UTF-8 JSON，尚未上传。");
  }
  if (
    !object(source) ||
    !string(source.name, 512) ||
    !source.name.trim() ||
    !string(source.type, 100) ||
    !Number.isSafeInteger(source.id) ||
    !Array.isArray(source.messages) ||
    !source.messages.length ||
    source.messages.length > 1000
  )
    throw new Error("仅支持单聊天导出 JSON（name/type/id/messages），1–1000 条；不支持整账户导出。");
  const ids = new Set<number>();
  const lines: string[] = [];
  let service = 0;
  let media = 0;
  for (const entry of source.messages) {
    if (!object(entry) || !Number.isSafeInteger(entry.id) || (entry.id as number) <= 0 || ids.has(entry.id as number))
      throw new Error("消息编号缺失、无效或重复，尚未上传。");
    ids.add(entry.id as number);
    if (entry.type === "service") {
      service++;
      continue;
    }
    if (
      entry.type !== "message" ||
      Object.hasOwn(entry, "rich_message") ||
      !string(entry.date, 100) ||
      !entry.date.trim() ||
      (entry.from != null && !string(entry.from, 512))
    )
      throw new Error(`消息 ${entry.id} 的类型、日期或发言人不受支持，尚未上传。`);
    let text: string;
    if (typeof entry.text === "string") text = entry.text;
    else if (
      Array.isArray(entry.text) &&
      entry.text.every((part) => typeof part === "string" || (object(part) && typeof part.text === "string"))
    )
      text = entry.text.map((part) => (typeof part === "string" ? part : part.text)).join("");
    else throw new Error(`消息 ${entry.id} 的正文格式不受支持，尚未上传。`);
    const hasMedia = [
      "photo",
      "file",
      "media_type",
      "contact_information",
      "location_information",
      "poll",
      "game_title",
      "game_description",
      "game_link",
      "invoice_information",
      "giveaway_information",
      "contact_vcard",
      "thumbnail",
    ].some((key) => Object.hasOwn(entry, key));
    if (hasMedia) media++;
    if (entry.reply_to_message_id != null && !Number.isSafeInteger(entry.reply_to_message_id)) throw new Error("回复编号无效。");
    lines.push(
      `[消息 ${entry.id}] ${entry.date} · ${entry.from ?? "未知发言人"}${entry.reply_to_message_id != null ? ` · 回复 ${entry.reply_to_message_id}` : ""}\n${text || "（无文字正文）"}${hasMedia ? "\n（含媒体或结构化内容；本入口未导入或解析，须查看原导出目录）" : ""}`,
    );
  }
  if (!lines.length) throw new Error("没有可预览的普通消息；仅有服务事件，尚未上传。");
  const transcript = lines.join("\n\n");
  const sha256 = await hash(data);
  const id = `mwc-${(await hash(bytes(JSON.stringify(["telegram-chat-v1", owner, sha256, file.name])))).slice(0, 30)}`;
  const content = `# 有记聊天原件\n\n#拾微 #reference #source/conversation\n\n## 会话与原文件名\n${fence(`${source.name}\n${file.name}`)}\n\n原件 SHA-256：\`${sha256}\`\ntelegram-chat-v1；${lines.length} 条普通消息，${service} 条服务事件仅保留在原件，${media} 条含未导入媒体/结构。日期按原导出文字保留，未推断时区。链接、HTML 与格式标记作为文字，不主动打开。\n\n## 消息正文（按原导出顺序，编号可回原 JSON 核对）\n${fence(transcript)}\n\n原 JSON 字节保存在 .original.zip。此记录不是完整媒体备份或真实性证明。删除使用原生记录删除流程，并核对附件及外部备份。`;
  if (bytes(content).length > 256 * 1024) throw new Error("解析正文超过 256 KiB，请缩小导出范围；不会截断后保存。");
  return {
    item: { id, owner, filename: file.name, data, sha256, content },
    title: source.name,
    transcript,
    messages: lines.length,
    service,
    media,
  };
}

// Reuse the existing owner-bound, byte-verified single-original save/retry protocol. No ASR call.
export const saveChat = (plan: ChatPlan, signal: AbortSignal, receipt: (value: AudioReceipt) => void) =>
  saveAudio(plan.item, signal, receipt);

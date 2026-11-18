import { type AudioReceipt, saveAudio } from "./audioImport";
import type { BatchSource } from "./batchImport";
import type { HTMLText } from "./htmlText";
export type HTMLPlan = { item: BatchSource; parsed: HTMLText };
const encode = (text: string) => new TextEncoder().encode(text);
const hash = async (data: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(data))))
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
const fence = (text: string) => {
  let n = 3;
  for (const match of text.matchAll(/`+/g)) n = Math.max(n, match[0].length + 1);
  const mark = "`".repeat(n);
  return `${mark}\n${text}\n${mark}`;
};
export function parseHTMLInWorker(html: string, signal: AbortSignal): Promise<HTMLText> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./html.worker.ts", import.meta.url), { type: "module" });
    } catch {
      reject(new Error("此浏览器无法启动本地解析 Worker，尚未上传。"));
      return;
    }
    let settled = false;
    const finish = (error?: Error, result?: HTMLText) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      worker.terminate();
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const cancel = () => finish(new DOMException("已取消本地解析。", "AbortError"));
    const timer = setTimeout(() => finish(new Error("网页解析超过 5 秒，已终止，尚未上传。")), 5000);
    signal.addEventListener("abort", cancel, { once: true });
    worker.onerror = () => finish(new Error("本地网页解析失败，尚未上传。"));
    worker.onmessage = (event: MessageEvent<{ result?: HTMLText; error?: string }>) => {
      if (event.data.error) finish(new Error(event.data.error));
      else if (event.data.result) finish(undefined, event.data.result);
      else finish(new Error("解析结果无效。"));
    };
    if (signal.aborted) cancel();
    else {
      try {
        worker.postMessage(html);
      } catch {
        finish(new Error("无法发送本地解析任务，尚未上传。"));
      }
    }
  });
}
export async function prepareHTML(file: File, owner: string, signal: AbortSignal): Promise<HTMLPlan> {
  if (!/^users\/[a-zA-Z0-9_-]+$/.test(owner)) throw new Error("请先登录。");
  if (!crypto.subtle) throw new Error("请使用 HTTPS 或本机 localhost，以便安全校验原件。");
  if (
    !/\.html?$/i.test(file.name) ||
    file.name.length > 240 ||
    /[\\/]/.test(file.name) ||
    Array.from(file.name).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new Error("请选择文件名有效的 HTML 原件。");
  if (!file.size || file.size > 512 * 1024) throw new Error("HTML 须非空且不超过 512 KiB。");
  const data = new Uint8Array(await file.arrayBuffer());
  signal.throwIfAborted();
  if (!data.length || data.length > 512 * 1024) throw new Error("HTML 大小无效，尚未上传。");
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new Error("仅支持 UTF-8 HTML，请保留原件并在外部转换副本后再选；不会猜测编码。");
  }
  const parsed = await parseHTMLInWorker(html, signal);
  signal.throwIfAborted();
  const sha256 = await hash(data);
  signal.throwIfAborted();
  const id = `mwh-${(await hash(encode(JSON.stringify(["html-text-v1", owner, sha256, file.name])))).slice(0, 30)}`;
  const content = `# 有记网页原件与提取文字\n\n#拾微 #reference #source/link\n\n## 来源信息（网页自述，未访问或认证）\n${fence(`标题：${parsed.title || "未提供"}\n作者：${parsed.author || "未提供"}\n来源：${parsed.source || "未提取可用的绝对 canonical URL"}\n原文件：${file.name}`)}\n\n原件 SHA-256：\`${sha256}\`\nhtml-text-v1 / parse5 8.0.1；选择 ${parsed.selection}，不是智能摘要、OCR 或完整网页备份。\n\n## 提取文字（请核对原件，可能遗漏或包含非正文）\n${fence(parsed.text)}\n\n原 HTML 字节保存在 ZIP；本应用不内联打开它。原件可能包含脚本、外链和私人元数据，下载后不要直接打开不可信 HTML。删除采用原生记录删除流程，并核对附件与外部备份。`;
  if (encode(content).length > 256 * 1024) throw new Error("正文及来源信息超过 256 KiB，尚未上传。");
  return { item: { id, owner, filename: file.name, data, sha256, content }, parsed };
}
export const saveHTML = (plan: HTMLPlan, signal: AbortSignal, receipt: (value: AudioReceipt) => void) =>
  saveAudio(plan.item, signal, receipt);

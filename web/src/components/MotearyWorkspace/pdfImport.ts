import { Code, ConnectError } from "@connectrpc/connect";
import { zipSync } from "fflate";
import { getAccessToken } from "@/auth-state";
import { attachmentServiceClient, authServiceClient, memoServiceClient } from "@/connect";
import type { Attachment } from "@/types/proto/api/attachment_service_pb";
import { type Memo, Visibility } from "@/types/proto/api/memo_service_pb";
import { type BatchSource, MAX_FILE, readOriginalArchive, validateBatchQuota, verifyOriginalArchive } from "./batchImport";
import type { CaptureCategory } from "./sources";

export type PDFPage = { page: number; text: string };
export type PDFPlan = { records: BatchSource[]; pages: PDFPage[]; sha256: string; filename: string; rootName: string };
const digest = async (data: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(data))))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
const encode = (text: string) => new Uint8Array(new TextEncoder().encode(text));
const archiveName = (item: BatchSource) => `${item.id}.original.zip`;
const errors: Record<string, string> = {
  unavailable: "当前有记服务尚未启用本地 PDF 解析。请让管理员按运行说明配置；仍可通过普通导入保留原件。",
  busy: "本地解析器正在处理另一份资料，请稍后重试。",
  invalid_pdf: "文件不是可处理的 PDF，尚未保存记录。",
  encrypted_pdf: "暂不支持加密 PDF，尚未保存记录。",
  no_text: "未找到已有文字，可能是扫描件；当前未启用 OCR，尚未保存记录。",
  page_limit: "PDF 最多支持 64 页，尚未保存记录。",
  text_limit: "提取正文超过 256 KiB，尚未保存记录。",
  too_large: "PDF 原件最多 16 MiB，尚未保存记录。",
  parse_failed: "本地解析失败或超过资源限制，尚未保存记录。",
  cancelled: "解析已取消，尚未保存记录。",
};

function fenced(text: string): string {
  const marker = "`".repeat(Math.max(3, 1 + (text.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0)));
  return `${marker}\n${text}\n${marker}`;
}

function splitText(text: string): string[] {
  const parts: string[] = [];
  let part = "";
  let size = 0;
  for (const character of text) {
    const width = encode(character).length;
    if (size + width > 4096) {
      parts.push(part);
      part = "";
      size = 0;
    }
    part += character;
    size += width;
  }
  if (part) parts.push(part);
  return parts;
}

async function boundedJSON(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error("解析服务响应为空。");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024) throw new Error("解析服务响应超过限制。");
      chunks.push(value);
    }
    signal.throwIfAborted();
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function preparePDF(file: File, kind: CaptureCategory, owner: string, signal: AbortSignal): Promise<PDFPlan> {
  if (!/^users\/[a-zA-Z0-9_-]+$/.test(owner)) throw new Error("请先登录再处理资料。");
  if (!/\.pdf$/i.test(file.name) || /[\\/]/.test(file.name) || Array.from(file.name).some((character) => character.charCodeAt(0) < 32))
    throw new Error("请选择文件名有效的 PDF。");
  if (file.size > MAX_FILE) throw new Error(errors.too_large);
  signal.throwIfAborted();
  // Use the existing Connect transport to refresh session credentials before raw-byte fetch.
  const { user } = await authServiceClient.getCurrentUser({}, { signal });
  if (user?.name !== owner) throw new Error("当前账户已变化，请重新选择资料。");
  const data = new Uint8Array(await file.arrayBuffer());
  if (data.length > MAX_FILE) throw new Error(errors.too_large);
  signal.throwIfAborted();
  const sha256 = await digest(data);
  const token = getAccessToken();
  const response = await fetch("/api/youji/pdf/parse", {
    method: "POST",
    body: new Uint8Array(data).buffer,
    headers: { "Content-Type": "application/pdf", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
    signal,
  });
  const result = (await boundedJSON(response, signal)) as {
    error?: string;
    parser?: string;
    version?: string;
    sha256?: string;
    pages?: PDFPage[];
  };
  if (!response.ok) throw new Error(errors[result.error ?? ""] ?? "无法解析 PDF，请检查登录、连接和本地解析服务。");
  if (result.parser !== "pypdf" || result.version !== "7.1.1" || result.sha256 !== sha256 || !Array.isArray(result.pages))
    throw new Error("解析来源或版本校验失败，尚未保存记录。");
  const pages = result.pages;
  if (
    pages.length < 1 ||
    pages.length > 64 ||
    pages.some((page, index) => page.page !== index + 1 || typeof page.text !== "string") ||
    pages.reduce((total, page) => total + encode(page.text).length, 0) > 256 * 1024
  )
    throw new Error("解析页码或正文大小无效，尚未保存记录。");
  const rootId = `mwp-${(await digest(encode(JSON.stringify(["web-pdf-v1", owner, sha256, file.name, kind, result.version])))).slice(0, 30)}`;
  const rootName = `memos/${rootId}`;
  const provenance = `原件 SHA-256：\`${sha256}\`\n本地解析：pypdf 7.1.1 · web-pdf-v1（非 OCR / 非 AI）`;
  const tags = `#拾微 #${kind} #source/file #derived/pdftext`;
  const records: BatchSource[] = [];
  const links: string[] = [];
  for (const page of pages) {
    if (!page.text.trim()) {
      links.push(`- 第 ${page.page} 页：无可提取文字，原页保留，未做 OCR。`);
      continue;
    }
    for (const [index, text] of splitText(page.text).entries()) {
      const id = `mwd-${(await digest(encode(`${rootId}:${page.page}:${index}`))).slice(0, 30)}`;
      const body = encode(text);
      records.push({
        id,
        owner,
        filename: `page-${page.page}-part-${index + 1}.txt`,
        data: body,
        sha256: await digest(body),
        content: `# 有记 PDF 正文 · 第 ${page.page} 页 / 段 ${index + 1}\n\n${tags}\n\n[返回完整 PDF 原件](/${rootName})\n${provenance}\n\n原文件名：\n${fenced(file.name)}\n\n机器提取顺序与字形可能有误，请对照原页核实。正文可编辑；修改后重试不会覆盖。\n\n${fenced(text)}`,
      });
      links.push(`- [第 ${page.page} 页 / 段 ${index + 1}](/memos/${id})`);
    }
  }
  if (!records.length) throw new Error(errors.no_text);
  if (records.length > 64) throw new Error("正文超过 64 段，尚未保存记录。");
  records.unshift({
    id: rootId,
    owner,
    filename: file.name,
    data,
    sha256,
    content: `# 有记 PDF 原件与页码索引\n\n${tags}\n\n原文件名：\n${fenced(file.name)}\n\n${provenance}\n\n完整 PDF 原字节在 ZIP 附件。以下为计划页段链接；索引存在不代表全部写入，以上传界面完成状态为准。中断后重新选择同一文件和类别可核验恢复。\n删除本索引不会自动删除正文；整份清理请在 PDF 导入面板重新解析相同文件后检查清理范围。用户修改过的记录需人工核对。关键词按单段匹配，无 OCR 或语义理解。\n\n${links.join("\n")}`,
  });
  await validateBatchQuota(records, signal);
  signal.throwIfAborted();
  return { records, pages, sha256, filename: file.name, rootName };
}

async function account(plan: PDFPlan, signal: AbortSignal) {
  const { user } = await authServiceClient.getCurrentUser({}, { signal });
  if (!user || plan.records.some((record) => record.owner !== user.name)) throw new Error("当前账户已变化，请重新选择资料。");
}

async function getMemo(name: string, signal: AbortSignal): Promise<Memo | undefined> {
  try {
    return await memoServiceClient.getMemo({ name }, { signal });
  } catch (error) {
    if (error instanceof ConnectError && error.code === Code.NotFound) return undefined;
    throw error;
  }
}

async function verifyAttachment(item: BatchSource, attachment: Attachment, signal: AbortSignal) {
  if (
    attachment.creator !== item.owner ||
    attachment.externalLink ||
    attachment.filename !== archiveName(item) ||
    !/^attachments\/[a-zA-Z0-9-]+$/.test(attachment.name)
  )
    throw new Error("原件附件归属或名称不一致，已停止。");
  const token = getAccessToken();
  const response = await fetch(`/file/${attachment.name}/${encodeURIComponent(attachment.filename)}`, {
    signal,
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new Error("无法校验原件附件，已停止。");
  await verifyOriginalArchive(await readOriginalArchive(response, signal), item.filename, item.sha256);
}

async function verifyMemo(item: BatchSource, signal: AbortSignal): Promise<boolean> {
  const memo = await getMemo(`memos/${item.id}`, signal);
  if (!memo) return false;
  if (
    memo.creator !== item.owner ||
    memo.visibility !== Visibility.PRIVATE ||
    memo.content !== item.content ||
    memo.attachments.length !== 1
  )
    throw new Error(`记录 ${memo.name} 的正文、权限或附件已变化，未覆盖或删除。`);
  await verifyAttachment(item, memo.attachments[0], signal);
  return true;
}

async function unattached(item: BatchSource, signal: AbortSignal): Promise<Attachment[]> {
  const filter = `creator == ${JSON.stringify(item.owner)} && filename == ${JSON.stringify(archiveName(item))}`;
  const found = await attachmentServiceClient.listAttachments({ filter, pageSize: 5 }, { signal });
  if (found.nextPageToken || found.attachments.length > 4) throw new Error("同一资料的上传候选超过安全上限，请先在附件管理中核对。");
  const candidates: Attachment[] = [];
  for (const attachment of found.attachments) {
    // Never take an attachment away from an existing memo, even one we own.
    if (attachment.memo) continue;
    await verifyAttachment(item, attachment, signal);
    candidates.push(attachment);
  }
  return candidates;
}

async function checkOriginal(plan: PDFPlan, signal: AbortSignal) {
  let pageToken = "";
  const filter = `creator == ${JSON.stringify(plan.records[0].owner)} && content.contains(${JSON.stringify(plan.sha256)})`;
  for (let page = 0; page < 10; page++) {
    const result = await memoServiceClient.listMemos({ filter, pageSize: 100, pageToken }, { signal });
    const conflict = result.memos.find((memo) => memo.name !== plan.rootName && /^memos\/(mw-|ml-|mui-|mul-|mp-|mwp-)/.test(memo.name));
    if (conflict) throw new Error(`可能已有相同原件：${conflict.name}。请使用原入口核对，不会自动合并。`);
    pageToken = result.nextPageToken;
    if (!pageToken) return;
  }
  throw new Error("原件查重超过安全分页上限，尚未上传。");
}

export async function savePDFPlan(plan: PDFPlan, signal: AbortSignal, onRecord: (name: string, status: "imported" | "verified") => void) {
  await account(plan, signal);
  await validateBatchQuota(plan.records, signal);
  await checkOriginal(plan, signal);
  for (const item of plan.records) {
    signal.throwIfAborted();
    const name = `memos/${item.id}`;
    if (await verifyMemo(item, signal)) {
      onRecord(name, "verified");
      continue;
    }
    const candidates = await unattached(item, signal);
    if (candidates.length > 1)
      throw new Error(`发现多个可核验未关联上传：${candidates.map((entry) => entry.name).join("、")}。请先预览清理范围。`);
    let attachment = candidates[0];
    if (!attachment) {
      attachment = await attachmentServiceClient.createAttachment(
        {
          attachment: {
            filename: archiveName(item),
            type: "application/zip",
            content: zipSync({ [item.filename]: new Uint8Array(item.data) }, { level: 0 }),
          },
        },
        { signal },
      );
    } else {
      // Re-read immediately before reuse; no server transaction/CAS is claimed.
      const current = await attachmentServiceClient.getAttachment({ name: attachment.name }, { signal });
      if (current.memo) throw new Error("待恢复附件已被关联，请重新核验后再保存。");
      await verifyAttachment(item, current, signal);
    }
    try {
      signal.throwIfAborted();
      await memoServiceClient.createMemo(
        { memoId: item.id, memo: { content: item.content, visibility: Visibility.PRIVATE, attachments: [{ name: attachment.name }] } },
        { signal },
      );
    } catch {
      throw new Error(
        `记录 ${name} 的写入结果不确定；已获回执附件 ${attachment.name}。重试会核验并尝试复用未关联原件，或先预览清理；不会自动删除。`,
      );
    }
    onRecord(name, "imported");
  }
}

export async function previewPDFDeletion(plan: PDFPlan, signal: AbortSignal) {
  await account(plan, signal);
  let present = 0;
  const orphanAttachments: string[] = [];
  for (const record of plan.records) {
    if (await verifyMemo(record, signal)) present++;
    orphanAttachments.push(...(await unattached(record, signal)).map((attachment) => attachment.name));
  }
  return { rootName: plan.rootName, present, planned: plan.records.length, orphanAttachments };
}

/** Caller must explicitly confirm deletion of planned records and all their comment subtrees. */
export async function deletePDFPlan(
  plan: PDFPlan,
  signal: AbortSignal,
  onRecord: (name: string) => void,
  confirmed: { rootName: string; orphanAttachments: string[] },
) {
  if (confirmed.rootName !== plan.rootName) throw new Error("清理确认与当前资料不一致，请重新检查范围。");
  const allowed = new Set(confirmed.orphanAttachments);
  const currentPreview = await previewPDFDeletion(plan, signal);
  if (currentPreview.orphanAttachments.length !== allowed.size || currentPreview.orphanAttachments.some((name) => !allowed.has(name)))
    throw new Error("未关联上传范围发生变化，请重新检查并确认，不会扩大删除范围。");
  for (const record of [...plan.records.slice(1).reverse(), plan.records[0]]) {
    signal.throwIfAborted();
    const name = `memos/${record.id}`;
    if (await verifyMemo(record, signal)) await memoServiceClient.deleteMemo({ name }, { signal });
    // Includes only deterministic-name, byte-verified, same-owner unlinked archives.
    for (const attachment of await unattached(record, signal)) {
      if (!allowed.has(attachment.name)) throw new Error("发现未确认的新上传，已停止，请重新检查清理范围。");
      const current = await attachmentServiceClient.getAttachment({ name: attachment.name }, { signal });
      if (current.memo) throw new Error("清理候选已被关联，已停止；请重新检查范围。");
      await verifyAttachment(record, current, signal);
      await attachmentServiceClient.deleteAttachment({ name: current.name }, { signal });
      allowed.delete(current.name);
    }
    onRecord(name);
  }
  if (allowed.size) throw new Error("部分已确认附件的关联状态已变化，清理未全部确认；请重新检查范围。");
}

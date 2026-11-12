import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { downloadFileFromUrl } from "@/lib/browser";
import {
  type BatchItemState,
  type BatchSource,
  buildBatchReceipt,
  ImportQuotaError,
  ingestBatchSource,
  prepareBatch,
  prepareLongBatch,
  type TextEncoding,
  validateBatchQuota,
} from "./batchImport";
import { CATEGORY_LABELS, type CaptureCategory } from "./sources";

export default function BatchImport({ onSaved, userName }: { onSaved: () => void; userName: string }) {
  const [longMode, setLongMode] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [kind, setKind] = useState<CaptureCategory>("reference");
  const [textEncoding, setTextEncoding] = useState<TextEncoding>("utf-8");
  const [note, setNote] = useState("");
  const [items, setItems] = useState<BatchSource[]>([]);
  const [states, setStates] = useState<Record<string, BatchItemState>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const lock = useRef(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);
  const reset = () => {
    setItems([]);
    setConfirmed(false);
    setStates({});
    setError("");
  };
  const preview = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const prepared = longMode
        ? await prepareLongBatch(files, kind, note, userName)
        : await prepareBatch(files, kind, note, userName, textEncoding);
      await validateBatchQuota(prepared);
      setItems(prepared);
      setStates({});
    } catch (e) {
      setItems([]);
      setError(e instanceof Error ? e.message : "文件预检失败。");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const upload = async () => {
    if (lock.current || !items.length || (longMode && !confirmed)) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const abort = new AbortController();
    controller.current = abort;
    try {
      for (const item of items) {
        if (abort.signal.aborted) break;
        setStates((s) => ({ ...s, [item.id]: "saving" }));
        try {
          const result = await ingestBatchSource(item, abort.signal);
          setStates((s) => ({ ...s, [item.id]: result.status === "verified" ? "verified" : "imported" }));
          onSaved();
        } catch (error) {
          setStates((s) => ({ ...s, [item.id]: "review" }));
          setError(
            error instanceof ImportQuotaError
              ? error.message
              : "已停止。当前项可能已写入，请先检查记录；再次点击保存会复核原件，不覆盖已改正文。可能存在未关联附件，不会自动删除。",
          );
          break;
        }
      }
    } finally {
      controller.current = null;
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="mb-9 rounded-xl border border-border bg-card p-5" aria-label="批量原件导入">
      <h2 className="text-lg font-semibold">一次收好一组材料</h2>
      <p className="my-2 text-xs leading-5 text-muted-foreground">
        选择本机文件，先预检再保存。全部私有，原件以 ZIP 保留；不会调用 AI。每批最多 32 个文件、32 MiB，单文件最多 16
        MiB。批量记录不加入空间。
      </p>
      <fieldset disabled={busy} className="flex flex-col gap-3 disabled:opacity-60">
        <label className="text-sm">
          <input
            type="checkbox"
            checked={longMode}
            onChange={(e) => {
              setLongMode(e.target.checked);
              reset();
            }}
          />
          长文分段模式（单个 UTF-8 TXT/Markdown，最多 256 KiB）
        </label>
        <label className="text-sm">
          选择多个资料
          <input
            ref={fileInput}
            aria-label="批量资料文件"
            type="file"
            multiple
            className="mt-1 block max-w-full text-xs"
            onChange={(e) => {
              setFiles(Array.from(e.target.files ?? []));
              reset();
            }}
          />
        </label>
        <label className="text-sm">
          批量分类{" "}
          <select
            aria-label="批量分类"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as CaptureCategory);
              reset();
            }}
          >
            {Object.entries(CATEGORY_LABELS).map(([key, value]) => (
              <option key={key} value={key}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          文本编码
          <select
            aria-label="文本编码"
            disabled={longMode}
            value={longMode ? "utf-8" : textEncoding}
            onChange={(event) => {
              setTextEncoding(event.target.value as TextEncoding);
              reset();
            }}
          >
            <option value="utf-8">UTF-8（默认）</option>
            <option value="gb18030">GB18030 / GBK（旧版中文文本）</option>
          </select>
          <span className="mt-1 block text-xs text-muted-foreground">
            仅作用于 TXT、Markdown、CSV、JSON；不会猜测编码或修改原件。不同编码的文本请分批导入。
          </span>
        </label>
        <label className="text-sm">
          共同批注
          <textarea
            aria-label="批量共同批注"
            value={note}
            maxLength={2000}
            onChange={(e) => {
              setNote(e.target.value);
              reset();
            }}
            className="mt-1 block w-full rounded border border-border bg-background p-2"
          />
        </label>
        <Button type="button" variant="outline" onClick={preview} disabled={!files.length} className="self-start">
          预检这批资料
        </Button>
      </fieldset>
      {items.length > 0 && (
        <>
          <ul className="my-4 space-y-2 text-sm">
            {items.map((item) => (
              <li key={item.id} className="flex flex-wrap justify-between gap-2 border-b border-border py-2">
                <span className="break-all">
                  {item.filename} · {(item.data.length / 1024).toFixed(1)} KiB
                </span>
                <span>
                  {states[item.id]
                    ? { saving: "正在保存 / 核验", imported: "已保存", verified: "已复核原件", review: "需检查" }[states[item.id]]
                    : "已预检，尚未保存"}
                </span>
                <details className="w-full">
                  <summary className="cursor-pointer text-xs text-muted-foreground">检查将保存的正文（前 800 字）</summary>
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
                    {item.content.slice(0, 800)}
                  </pre>
                </details>
                {states[item.id] && states[item.id] !== "saving" && (
                  <a
                    href={`/memos/${encodeURIComponent(item.id)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                    aria-label={`查看记录 ${item.filename}`}
                  >
                    查看记录
                  </a>
                )}
              </li>
            ))}
          </ul>
          {longMode && (
            <label className="my-3 block text-sm">
              <input type="checkbox" checked={confirmed} disabled={busy} onChange={(e) => setConfirmed(e.target.checked)} />
              我确认保存完整原件与 {items.length - 1} 条私有分段，约占两份文本空间；这是多次写入，中断可能部分完成。
              删除索引不会删除分段，重新导入会补回缺失段。
            </label>
          )}
          <p role="status" className="my-2 text-sm">
            已保存或核验 {items.filter((item) => states[item.id] === "imported" || states[item.id] === "verified").length}/{items.length}{" "}
            条。
            {items.some((item) => states[item.id] === "review")
              ? "部分完成或状态待核对，请检查后重试。"
              : "请以全部记录核验完成为准，不以索引存在判定成功。"}
          </p>
          <Button type="button" onClick={upload} disabled={busy || (longMode && !confirmed)}>
            保存为私有记录 / 复核重试
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            className="ms-2"
            onClick={() => {
              const blob = new Blob([JSON.stringify(buildBatchReceipt(items, states), null, 2)], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              downloadFileFromUrl(url, "moteary-import-receipt.json");
              window.setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            下载本批回执
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">
            回执仅含文件名、校验值和状态，不含正文、批注或令牌；文件名也可能敏感，请谨慎分享。需检查的记录可能尚不存在。
          </p>
        </>
      )}
      {files.length > 0 && !busy && (
        <Button
          type="button"
          variant="outline"
          className="ms-2"
          onClick={() => {
            setFiles([]);
            setNote("");
            reset();
            if (fileInput.current) fileInput.current.value = "";
          }}
        >
          清空本页队列
        </Button>
      )}
      {busy && controller.current && (
        <Button type="button" variant="outline" onClick={() => controller.current?.abort()} className="ms-2">
          停止这批导入
        </Button>
      )}
      {busy && (
        <p role="status" className="mt-3 text-sm">
          正在处理，请勿关闭页面。
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        清空队列仅移除本页文件与批注，不删除已保存记录。选择的文件与队列只留在本页内存。中断后重新选择同一文件和相同分类、批注即可复核；此界面与
        CLI 的导入身份各自独立；跨入口发现可能相同原件时会停止，请使用原入口继续。不会自动合并或删除已有记录。
      </p>
    </section>
  );
}

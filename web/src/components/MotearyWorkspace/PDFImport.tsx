import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { deletePDFPlan, type PDFPlan, preparePDF, previewPDFDeletion, savePDFPlan } from "./pdfImport";
import { CATEGORY_LABELS, type CaptureCategory } from "./sources";

const recordPath = (name: string) => `/memos/${encodeURIComponent(name.split("/").at(-1) ?? "")}`;
type Cleanup = { rootName: string; present: number; planned: number; orphanAttachments: string[] };

export default function PDFImport({ userName, onSaved }: { userName: string; onSaved: () => void }) {
  const [file, setFile] = useState<File>();
  const [kind, setKind] = useState<CaptureCategory>("reference");
  const [plan, setPlan] = useState<PDFPlan>();
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [cleanup, setCleanup] = useState<Cleanup>();
  const [confirmed, setConfirmed] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  const reset = () => {
    setPlan(undefined);
    setSaved({});
    setCleanup(undefined);
    setConfirmed(false);
    setError("");
    setMessage("");
  };
  const run = async (action: "解析" | "保存" | "检查" | "清理") => {
    if (controller.current || (action === "解析" ? !file : !plan)) return;
    if (action === "清理" && (!cleanup || !confirmed)) return;
    const abort = new AbortController();
    controller.current = abort;
    const active = () => mounted.current && controller.current === abort && !abort.signal.aborted;
    setBusy(action);
    setError("");
    setMessage("");
    try {
      if (action === "解析" && file) {
        if (file.size > 16 * 1024 * 1024) throw new Error("PDF 不能超过 16 MiB。");
        if (!file.name.toLowerCase().endsWith(".pdf")) throw new Error("请选择一个 PDF 文件。");
        const result = await preparePDF(file, kind, userName, abort.signal);
        if (active()) {
          setPlan(result);
          setSaved({});
          setCleanup(undefined);
          setConfirmed(false);
          setMessage("解析完成，尚未保存记录。请核对逐页文本。");
        }
      } else if (action === "保存" && plan) {
        setCleanup(undefined);
        setConfirmed(false);
        await savePDFPlan(plan, abort.signal, (name, status) => {
          if (!active()) return;
          setSaved((previous) => ({ ...previous, [name]: status === "verified" ? "已核验已有记录" : "已保存" }));
          onSaved();
        });
        if (active()) setMessage("原件与可检索正文已全部保存。可打开原件记录查看关联内容。");
      } else if (action === "检查" && plan) {
        setCleanup(undefined);
        setConfirmed(false);
        const result = await previewPDFDeletion(plan, abort.signal);
        if (active()) setCleanup(result);
      } else if (action === "清理" && plan && cleanup) {
        setConfirmed(false);
        setCleanup(undefined);
        await deletePDFPlan(
          plan,
          abort.signal,
          (name) => {
            if (!active()) return;
            setSaved((previous) => ({ ...previous, [name]: "已删除" }));
            onSaved();
          },
          cleanup,
        );
        if (active()) setMessage("这份导入的清理已完成。不是存储介质或备份的物理擦除。");
      }
    } catch (cause) {
      if (active()) {
        setError(`${action}未完成：${cause instanceof Error ? cause.message : "服务暂不可用，请稍后重试。"}`);
        if (action === "保存" || action === "清理") setMessage("部分操作可能已生效；请检查下方结果，再重试或重新检查清理范围。");
      }
    } finally {
      if (controller.current === abort) {
        controller.current = null;
        if (mounted.current) setBusy("");
      }
    }
  };
  const cancel = () => {
    controller.current?.abort();
    controller.current = null;
    setBusy("");
    setCleanup(undefined);
    setConfirmed(false);
    setMessage(
      busy === "解析" ? "已取消解析等待，未保存记录。" : "已取消等待。保存或清理可能已有部分生效；保留预览，可重试或重新检查清理范围。",
    );
  };
  return (
    <section className="mb-9 rounded-xl border border-border bg-card p-4" aria-label="PDF 本地解析">
      <h2 className="mb-2 text-base font-medium">把 PDF 变成可找回的资料</h2>
      <p className="mb-3 text-xs leading-6 text-muted-foreground">
        刷新后可重新选择同一文件及分类恢复；更换文件或分类不会清理此前上传。点击后将 PDF 发送到当前有记实例，由服务器本地 Python
        解析，不发送云端 AI。预览不会保存记录；仅提取已有文本，不做 OCR。 单文件不超过 16
        MiB。请确认你信任当前实例。保存为仅自己可见的记录；当前空间或筛选可能隐藏结果，可用原件链接打开。
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <label className="min-w-0 text-xs">
          PDF 文件
          <input
            type="file"
            accept=".pdf,application/pdf"
            aria-label="PDF 文件"
            disabled={!!busy}
            className="block w-full max-w-xs"
            onChange={(event) => {
              reset();
              setFile(event.target.files?.[0]);
            }}
          />
        </label>
        <label className="text-xs">
          PDF 分类
          <select
            aria-label="PDF 分类"
            disabled={!!busy}
            value={kind}
            onChange={(event) => {
              reset();
              setKind(event.target.value as CaptureCategory);
            }}
          >
            {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <Button variant="outline" disabled={!!busy || !file} onClick={() => void run("解析")}>
          本地解析并预览
        </Button>
        {busy && (
          <Button variant="outline" onClick={cancel}>
            取消{busy}
          </Button>
        )}
      </div>
      {busy && (
        <p role="status" className="mt-3 text-xs">
          正在{busy}，请勿关闭页面…
        </p>
      )}
      {message && (
        <p role="status" className="mt-3 text-xs">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {error}
        </p>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        如果解析服务不可用，仍可使用下方“音频 / 文档”普通上传保留原件；附件文字不会因此变得可搜索。
      </p>
      {plan && (
        <div className="mt-4 space-y-3">
          <p className="break-all text-sm">
            {plan.filename} · {plan.pages.length} 页 · {plan.records.length} 条待保存记录
          </p>
          <div className="max-h-80 overflow-y-auto">
            {plan.pages.map((page) => (
              <details key={page.page} className="border-b border-border py-2">
                <summary className="cursor-pointer text-sm">
                  第 {page.page} 页{page.text.trim() ? "" : " · 无可提取文字"}
                </summary>
                <pre className="whitespace-pre-wrap break-words py-2 text-xs">
                  {page.text || "无文字页；扫描件可能需要 OCR，本次不执行。"}
                </pre>
              </details>
            ))}
          </div>
          <Button disabled={!!busy} onClick={() => void run("保存")}>
            保存原件与可检索正文
          </Button>
          <p className="text-xs">
            已确认 {Object.values(saved).filter((status) => status !== "已删除").length} / {plan.records.length} 条
          </p>
          <Link className="block text-xs underline" to={recordPath(plan.rootName)}>
            打开原件记录（保存后可用）
          </Link>
          <ul className="space-y-1 text-xs">
            {Object.entries(saved).map(([name, status]) => (
              <li key={name} className="break-all">
                {status} ·{" "}
                {status === "已删除" ? (
                  name
                ) : (
                  <Link className="underline" to={recordPath(name)}>
                    {name}
                  </Link>
                )}
              </li>
            ))}
          </ul>
          <Button variant="outline" disabled={!!busy} onClick={() => void run("检查")}>
            检查这份导入的清理范围
          </Button>
          {cleanup && (
            <div className="space-y-2 rounded border border-destructive/40 p-3 text-xs">
              <p className="break-all">
                原件记录：{cleanup.rootName} · 计划 {cleanup.planned} 条 · 当前存在 {cleanup.present} 条
              </p>
              <p>另有 {cleanup.orphanAttachments.length} 个已核验的未关联上传将被清理：</p>
              <ul>
                {cleanup.orphanAttachments.map((name) => (
                  <li key={name} className="break-all">
                    {name}
                  </li>
                ))}
              </ul>
              <p>删除不可撤销，包括这些记录的全部评论（含归档和嵌套评论）。请先停止其他设备编辑。此操作不是存储介质或备份的物理擦除。</p>
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={confirmed} disabled={!!busy} onChange={(event) => setConfirmed(event.target.checked)} />
                我已核对范围并确认不可撤销删除
              </label>
              <Button variant="destructive" disabled={!!busy || !confirmed} onClick={() => void run("清理")}>
                确认删除这份导入
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

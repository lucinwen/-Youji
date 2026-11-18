import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import type { AudioReceipt } from "./audioImport";
import { type HTMLPlan, prepareHTML, saveHTML } from "./htmlImport";

export default function HTMLImport({ userName, onSaved }: { userName: string; onSaved: () => void }) {
  const [plan, setPlan] = useState<HTMLPlan>();
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState("");
  const [receipt, setReceipt] = useState<AudioReceipt>();
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    setPlan(undefined);
    setReceipt(undefined);
    setConfirmed(false);
    setMessage("");
    setBusy(false);
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, [userName]);
  const preview = async (file: File) => {
    if (active.current) return;
    const job = new AbortController();
    active.current = job;
    setBusy(true);
    setPlan(undefined);
    setReceipt(undefined);
    setConfirmed(false);
    setMessage("正在本地读取，尚未上传。");
    try {
      const next = await prepareHTML(file, userName, job.signal);
      if (!job.signal.aborted) {
        setPlan(next);
        setMessage("预览完成，尚未上传。请检查文字与来源信息。");
      }
    } catch (error) {
      if (!job.signal.aborted) setMessage(error instanceof Error ? error.message : "预览失败，尚未上传。");
    } finally {
      if (active.current === job) {
        active.current = null;
        setBusy(false);
      }
    }
  };
  const save = async () => {
    if (!plan || !confirmed || active.current) return;
    const job = new AbortController();
    active.current = job;
    setBusy(true);
    try {
      const result = await saveHTML(plan, job.signal, (value) => {
        if (!job.signal.aborted) setReceipt(value);
      });
      if (!job.signal.aborted) {
        setReceipt(result);
        setMessage(
          result.status === "verified" ? "已有原件与正文已核验，未重复创建。" : "已仅自己可见保存。当前筛选可能不包含它，可直接打开记录。",
        );
        onSaved();
      }
    } catch (error) {
      if (!job.signal.aborted) setMessage(error instanceof Error ? error.message : "保存未完成，请保留原件并重试核验。");
    } finally {
      if (active.current === job) {
        active.current = null;
        setBusy(false);
      }
    }
  };
  return (
    <section aria-label="本地 HTML 导入" className="space-y-3 p-3">
      <p className="text-sm">
        选择 UTF-8 HTML（最多 512 KiB）。在本地 Worker 提取首个 article、main 或 body 的文字，不加载原网页资源、不运行脚本、不渲染原始
        HTML。不是智能正文识别，可能遗漏或包含非正文；请核对预览。
      </p>
      <p className="text-xs text-muted-foreground">
        保存需新版有记服务器与 SQLite；原 HTML 的 ZIP 与 PRIVATE
        记录一同提交。旧版记录可能提示冲突，请打开原记录核对，不会自动覆盖或迁移。正文还受账号配额限制，超限不会截断。原件包含未展示字段，仍须核对敏感内容。
      </p>
      <label className="block text-sm">
        本地 HTML 原件
        <input
          aria-label="本地 HTML 原件"
          type="file"
          accept=".html,.htm,text/html"
          disabled={busy}
          className="mt-2 block max-w-full"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void preview(file);
            event.target.value = "";
          }}
        />
      </label>
      {plan && (
        <>
          <p className="break-words text-sm">
            {plan.parsed.title || "无标题网页"} · 作者：{plan.parsed.author || "未提供"} · 原文件：{plan.item.filename} · 选择{" "}
            {plan.parsed.selection} · 来源（仅文字）：{plan.parsed.source || "未提取"}
          </p>
          <pre aria-label="网页文字预览" className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border p-3 text-xs">
            {plan.parsed.text}
          </pre>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} />
            我已核对提取文字，知晓原件中未显示的脚本、身份信息和元数据也会上传，同意仅自己可见保存至有记服务器
          </label>
          <Button className="min-h-11" disabled={!confirmed || busy} onClick={() => void save()}>
            保存网页原件与文字
          </Button>
        </>
      )}
      {busy && (
        <Button
          variant="outline"
          onClick={() => {
            active.current?.abort();
            active.current = null;
            setBusy(false);
            setMessage("已停止等待；已提交写入不保证撤销。保留同一原件，重试会核验，不要另建副本。");
          }}
        >
          停止等待
        </Button>
      )}
      {message && (
        <p role="status" className="break-words text-sm">
          {message}
        </p>
      )}
      {receipt && (
        <div className="space-y-2 break-all text-xs">
          <p>
            恢复回执：{receipt.status} · {receipt.memo}
            {receipt.attachment ? ` · ${receipt.attachment}` : ""}
          </p>
          <Link className="underline" to={`/${receipt.memo}`}>
            打开网页记录 / 核对写入状态
          </Link>
          <p>
            刷新后重新选择同一原件并确认重试。正文被编辑时拒绝覆盖；未知上传会查找并校验可复用附件。多份残留须在附件管理人工核对，不自动删除。
          </p>
        </div>
      )}
    </section>
  );
}

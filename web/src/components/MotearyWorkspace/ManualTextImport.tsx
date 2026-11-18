import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import type { AudioReceipt } from "./audioImport";
import { type ManualSource, type ManualTextPlan, prepareManualText, preparePastedText, SOURCES, saveManualText } from "./manualTextImport";

export default function ManualTextImport({ userName, onSaved }: { userName: string; onSaved: () => void }) {
  const [mode, setMode] = useState<"paste" | "file">("paste");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File>();
  const [title, setTitle] = useState("");
  const [source, setSource] = useState<ManualSource>("unspecified");
  const [plan, setPlan] = useState<ManualTextPlan>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<"" | "预览" | "保存">("");
  const [message, setMessage] = useState("");
  const [receipt, setReceipt] = useState<AudioReceipt>();
  const active = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    setMode("paste");
    setText("");
    setFile(undefined);
    setTitle("");
    setSource("unspecified");
    setPlan(undefined);
    setConfirmed(false);
    setBusy("");
    setMessage("");
    setReceipt(undefined);
    if (fileInput.current) fileInput.current.value = "";
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, [userName]);
  const invalidatePreview = () => {
    active.current?.abort();
    active.current = null;
    setPlan(undefined);
    setConfirmed(false);
    setBusy("");
    setMessage("");
  };
  const run = async (action: "预览" | "保存") => {
    if (active.current || (action === "保存" && (!plan || !confirmed))) return;
    if (action === "预览" && (mode === "file" ? !file : !text.trim())) return;
    const job = new AbortController();
    active.current = job;
    const current = () => active.current === job && !job.signal.aborted;
    setBusy(action);
    setMessage(action === "预览" ? "正在本地预览，尚未上传。" : "正在保存，请保留原内容直到核验完成。");
    if (action === "预览") {
      setPlan(undefined);
      setConfirmed(false);
    }
    try {
      if (action === "预览") {
        const options = { source, title };
        const next =
          mode === "file" && file ? await prepareManualText(file, userName, options) : await preparePastedText(text, userName, options);
        if (current()) {
          setPlan(next);
          setMessage("预览完成，尚未上传。请核对标题、来源与正文后确认保存。");
        }
      } else if (plan) {
        const result = await saveManualText(plan, job.signal, (value) => {
          if (current()) setReceipt(value);
        });
        if (current()) {
          setReceipt(result);
          setMessage(
            result.status === "verified"
              ? "已有原件与正文已核验，未重复创建。"
              : "已仅自己可见保存。当前筛选可能不包含它，可直接打开记录。",
          );
          onSaved();
        }
      }
    } catch (error) {
      if (current())
        setMessage(
          error instanceof Error ? error.message : action === "预览" ? "预览失败，尚未上传。" : "保存未完成，请保留内容与回执后重试核验。",
        );
    } finally {
      if (active.current === job) {
        active.current = null;
        setBusy("");
      }
    }
  };
  return (
    <section aria-label="手动文本导入" className="min-w-0 space-y-3 p-3">
      <p className="text-sm">
        1 粘贴或选择 → 2 本地预览 → 3 确认私有保存。仅支持 UTF-8，最多 128 KiB。刷新后未保存内容会丢失，请手动保留原文件或文字。
      </p>
      <p className="text-sm">
        手动粘贴文字或选择 TXT / Markdown
        文件。不会连接微信、读取聊天账户、自动读取剪贴板或访问正文链接。来源由你选择，不代表内容已核验；请先检查敏感信息。
      </p>
      <div className="flex flex-wrap gap-2" aria-label="文本输入方式">
        {(
          [
            ["paste", "粘贴文字"],
            ["file", "选择文本文件"],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            variant="outline"
            className="min-h-11"
            aria-pressed={mode === value}
            disabled={!!busy}
            onClick={() => {
              if (mode !== value) {
                invalidatePreview();
                setMode(value);
                setFile(undefined);
              }
            }}
          >
            {label}
          </Button>
        ))}
      </div>
      {mode === "paste" ? (
        <label className="block text-sm">
          待导入文字
          <textarea
            aria-label="待导入文字"
            value={text}
            disabled={!!busy}
            className="mt-2 min-h-40 w-full rounded border border-border p-3"
            onChange={(event) => {
              invalidatePreview();
              setText(event.target.value);
            }}
          />
        </label>
      ) : (
        <label className="block text-sm">
          文本原件
          <input
            ref={fileInput}
            aria-label="文本原件"
            type="file"
            accept=".txt,.md,text/plain,text/markdown"
            disabled={!!busy}
            className="mt-2 block min-h-11 max-w-full"
            onChange={(event) => {
              invalidatePreview();
              setFile(event.target.files?.[0]);
            }}
          />
        </label>
      )}
      <label className="block text-sm">
        标题（可选）
        <input
          aria-label="文本标题"
          maxLength={200}
          value={title}
          disabled={!!busy}
          className="mt-2 min-h-11 w-full rounded border border-border px-3"
          onChange={(event) => {
            invalidatePreview();
            setTitle(event.target.value);
          }}
        />
      </label>
      <label className="block text-sm">
        来源（可选）
        <select
          aria-label="文本来源"
          value={source}
          disabled={!!busy}
          className="mt-2 min-h-11 w-full rounded border border-border px-3"
          onChange={(event) => {
            invalidatePreview();
            setSource(event.target.value as ManualSource);
          }}
        >
          {Object.entries(SOURCES).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <Button
        variant="outline"
        className="min-h-11"
        disabled={!!busy || (mode === "file" ? !file : !text.trim())}
        onClick={() => void run("预览")}
      >
        本地预览文字
      </Button>
      {plan && (
        <>
          <p className="break-words text-sm">
            {plan.title} · {SOURCES[plan.source]}
          </p>
          <pre aria-label="手动文本预览" className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border p-3 text-xs">
            {plan.text}
          </pre>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" checked={confirmed} disabled={!!busy} onChange={(event) => setConfirmed(event.target.checked)} />
            我已核对内容，同意将原件与正文仅自己可见保存至有记服务器
          </label>
          <Button className="min-h-11" disabled={!confirmed || !!busy} onClick={() => void run("保存")}>
            保存文本原件与正文
          </Button>
        </>
      )}
      {busy && (
        <Button
          variant="outline"
          className="min-h-11"
          onClick={() => {
            active.current?.abort();
            active.current = null;
            setBusy("");
            setMessage(
              busy === "保存"
                ? "已停止等待；已提交写入不保证撤销。保留相同内容和回执，重试核验，不要另建副本。"
                : "已停止本地预览，尚未上传。",
            );
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
            上次保存尝试的恢复回执：{receipt.status} · {receipt.memo}
            {receipt.attachment ? ` · ${receipt.attachment}` : ""}
          </p>
          <Link className="inline-flex min-h-11 items-center underline" to={`/${receipt.memo}`}>
            打开文本记录 / 核对写入状态
          </Link>
          <p>
            更改输入后需重新预览；上次回执仍保留供核对。保存失败可用同一计划重试。刷新前请保留原文件或粘贴内容、来源、标题及回执。多份附件残留请人工核对，不自动删除。
          </p>
        </div>
      )}
    </section>
  );
}

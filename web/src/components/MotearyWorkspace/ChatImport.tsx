import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import type { AudioReceipt } from "./audioImport";
import { type ChatPlan, prepareChat, saveChat } from "./chatImport";

export default function ChatImport({ userName, onSaved }: { userName: string; onSaved: () => void }) {
  const [plan, setPlan] = useState<ChatPlan>();
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
      const next = await prepareChat(file, userName);
      if (!job.signal.aborted) {
        setPlan(next);
        setMessage("预览完成，尚未上传。请检查消息及未导入内容。");
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
      const result = await saveChat(plan, job.signal, (value) => {
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
    <section aria-label="聊天 JSON 导入" className="space-y-3 p-3">
      <p className="text-sm">
        选择 Telegram Desktop 单聊天 JSON；最多 512 KiB、1000
        条。仅解析文字，不连接聊天账户、不访问链接、不导入媒体。原文件可能含敏感身份与消息，请先检查。
      </p>
      <label className="block text-sm">
        聊天 JSON 原件
        <input
          aria-label="聊天 JSON 原件"
          type="file"
          accept=".json,application/json"
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
            {plan.title}：{plan.messages} 条消息；{plan.service} 条服务事件仅保留在原件；{plan.media} 条含未导入媒体/结构。
          </p>
          <pre aria-label="聊天正文预览" className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border p-3 text-xs">
            {plan.transcript}
          </pre>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} />
            我已核对预览与未导入内容，同意将原件和正文仅自己可见保存至有记服务器
          </label>
          <Button className="min-h-11" disabled={!confirmed || busy} onClick={() => void save()}>
            保存聊天原件与正文
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
            打开聊天记录 / 核对写入状态
          </Link>
          <p>
            刷新后重新选择同一原件并确认重试。正文被编辑时拒绝覆盖；未知上传会查找并校验可复用附件。多份残留须在附件管理人工核对，不自动删除。
          </p>
        </div>
      )}
    </section>
  );
}

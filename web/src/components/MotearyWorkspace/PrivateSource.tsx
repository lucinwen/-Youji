import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { getRequestToken } from "@/connect";
import { Visibility } from "@/types/proto/api/memo_service_pb";

type SourceState = { status: "none" | "unavailable" } | { status: "available"; sourceName: string; content?: string };
type Action = { kind: "read" | "open" } | { kind: "save"; sourceName: string | null };
const validName = (name: string): boolean => /^memos\/[a-zA-Z0-9_-]+$/.test(name);

export async function requestPrivateSource(name: string, action: Action, signal: AbortSignal): Promise<SourceState> {
  if (!validName(name)) throw new Error("记录标识无效。");
  if (action.kind === "save" && action.sourceName !== null && !validName(action.sourceName)) throw new Error("请输入完整记录 ID：memos/…");
  const token = await getRequestToken();
  signal.throwIfAborted();
  const response = await fetch(`/api/youji/memos/${encodeURIComponent(name.slice(6))}/source${action.kind === "open" ? "/open" : ""}`, {
    method: action.kind === "save" ? "PATCH" : "GET",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
    signal,
    ...(action.kind === "save" ? { body: JSON.stringify({ sourceName: action.sourceName }) } : {}),
  });
  if (!response.ok) throw new Error("来源未能确认或当前不可用。请重新读取核对；不会显示旧正文。");
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || !("status" in data)) throw new Error("来源响应无效。");
  if (data.status === "none" || data.status === "unavailable") return { status: data.status };
  if (data.status !== "available" || !("sourceName" in data) || typeof data.sourceName !== "string" || !validName(data.sourceName))
    throw new Error("来源响应无效。");
  if (action.kind === "open") {
    if (!("content" in data) || typeof data.content !== "string") throw new Error("来源正文未能确认。");
    return { status: "available", sourceName: data.sourceName, content: data.content };
  }
  // Metadata never retains unexpected server snippets/title/content.
  return { status: "available", sourceName: data.sourceName };
}

function PrivateSourceEditor({ name }: { name: string }) {
  const id = useId();
  const [source, setSource] = useState<SourceState>();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);

  const request = async (action: Action) => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    setSource(undefined);
    setDraft("");
    setOpened(false);
    setError("");
    setBusy(true);
    try {
      const result = await requestPrivateSource(name, action, next.signal);
      if (next.signal.aborted || !alive.current) return;
      setSource(result);
      setDraft(result.status === "available" ? result.sourceName : "");
      setOpened(action.kind === "open" && result.status === "available");
    } catch (reason) {
      if (next.signal.aborted || !alive.current) return;
      setSource({ status: "unavailable" });
      setError(reason instanceof Error ? reason.message : "来源不可用。");
    } finally {
      if (!next.signal.aborted && alive.current) setBusy(false);
    }
  };
  const requestRef = useRef(request);
  requestRef.current = request;
  useEffect(() => {
    alive.current = true;
    void requestRef.current({ kind: "read" });
    const hide = () => {
      controller.current?.abort();
      setOpened(false);
      setSource(undefined);
      setDraft("");
      setBusy(false);
      setError("");
    };
    const focus = () => {
      void requestRef.current({ kind: "read" });
    };
    const visibility = () => {
      if (document.visibilityState === "visible") focus();
      else hide();
    };
    window.addEventListener("focus", focus);
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", visibility);
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  const close = () => {
    controller.current?.abort();
    setBusy(false);
    setOpened(false);
    setSource(undefined);
    setDraft("");
    setError("");
  };
  return (
    <div className="border-t border-border px-5 py-3 text-xs" aria-label="私密来源引用">
      <p className="font-medium">来源引用（可选）</p>
      <p className="mt-1 text-muted-foreground">仅关联自己当前的私密记录。同名材料请用完整 ID 区分；在来源卡片选中并复制“本记录 ID”。</p>
      <form
        className="mt-2 flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const sourceName = draft.trim();
          if (!validName(sourceName)) {
            setError("请输入完整记录 ID：memos/…");
            return;
          }
          if (sourceName === name) {
            setError("不能把本记录作为自己的来源。");
            return;
          }
          void request({ kind: "save", sourceName });
        }}
      >
        <label htmlFor={id} className="w-full">
          来源记录 ID
        </label>
        <input
          id={id}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="memos/…"
          maxLength={128}
          autoComplete="off"
          disabled={busy}
          className="min-h-11 min-w-0 flex-1 rounded border border-border bg-card px-2"
        />
        <Button type="submit" size="sm" className="min-h-11" disabled={busy}>
          设置来源
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="min-h-11"
          disabled={busy}
          onClick={() => void request({ kind: "save", sourceName: null })}
        >
          清除来源
        </Button>
      </form>
      <p className="mt-2 break-all" aria-live="polite">
        {source?.status === "available"
          ? `已关联来源 ID：${source.sourceName}`
          : source?.status === "none"
            ? "未设置来源"
            : source?.status === "unavailable"
              ? "来源当前不可用"
              : "来源尚未核对"}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="min-h-11"
          disabled={busy}
          onClick={() => void request({ kind: "read" })}
        >
          重新核对来源
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="min-h-11"
          disabled={busy || source?.status === "none"}
          onClick={() => void request({ kind: "open" })}
        >
          打开来源原文（重新核对）
        </Button>
      </div>
      {(opened || busy) && (
        <Button type="button" size="sm" variant="ghost" className="min-h-11" onClick={close}>
          关闭来源视图
        </Button>
      )}
      {busy && <p role="status">正在核对来源…</p>}
      {error && (
        <p role="alert" className="mt-2 text-destructive">
          {error}
        </p>
      )}
      {opened && source?.status === "available" && source.content !== undefined && (
        <section aria-label="已核对来源原文" className="mt-3 min-w-0 rounded border border-border p-3">
          <p className="break-all">来源 ID：{source.sourceName}</p>
          <pre className="mt-2 max-h-96 overflow-y-auto whitespace-pre-wrap break-words font-sans text-xs">{source.content}</pre>
          <p className="mt-2 text-muted-foreground">
            本次核对后显示的纯文本；不会执行链接或 Markdown。远端撤回不会瞬间收回已显示内容，请再次核对。
          </p>
        </section>
      )}
    </div>
  );
}

/** Remount on identity or visibility changes; no source body lives in query/local storage. */
export default function PrivateSource({ name, userName, visibility }: { name: string; userName: string; visibility: Visibility }) {
  if (visibility !== Visibility.PRIVATE) return null;
  return <PrivateSourceEditor key={`${userName}:${name}`} name={name} />;
}

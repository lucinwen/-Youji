import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { getRequestToken } from "@/connect";
import { validEventDate } from "./eventDates";

export type MemoDatesValue = { eventDate: string | null; capturedAt: string; captureTimeBasis: "captured" | "legacy-created" };

export async function requestMemoDates(name: string, signal: AbortSignal, eventDate?: string | null): Promise<MemoDatesValue> {
  if (!/^memos\/[a-zA-Z0-9_-]+$/.test(name)) throw new Error("记录标识无效。");
  if (eventDate != null && !validEventDate(eventDate)) throw new Error("请输入有效的事件日期。");
  const token = await getRequestToken();
  signal.throwIfAborted();
  const response = await fetch(`/api/youji/memos/${encodeURIComponent(name.slice(6))}/dates`, {
    method: eventDate === undefined ? "GET" : "PATCH",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
    signal,
    ...(eventDate === undefined ? {} : { body: JSON.stringify({ eventDate }) }),
  });
  if (!response.ok)
    throw new Error(response.status === 404 ? "记录不可用或不属于当前账户。" : "日期未能读取或保存，请重试；原文不会修改。");
  const value = (await response.json()) as MemoDatesValue;
  if (
    (value.eventDate !== null && !validEventDate(value.eventDate)) ||
    !["captured", "legacy-created"].includes(value.captureTimeBasis) ||
    !Number.isFinite(Date.parse(value.capturedAt))
  )
    throw new Error("日期响应无效，请刷新重试。");
  return value;
}

export default function MemoDates({ name, onChanged }: { name: string; onChanged: () => void }) {
  const id = useId();
  const [value, setValue] = useState<MemoDatesValue>();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<{ eventDate?: string | null }>({});
  const changed = useRef(onChanged);
  changed.current = onChanged;
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError("");
    void requestMemoDates(name, controller.signal, operation.eventDate)
      .then((next) => {
        if (controller.signal.aborted) return;
        setValue(next);
        setDraft(next.eventDate ?? "");
        if (operation.eventDate !== undefined) changed.current();
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setValue(undefined);
          setError(reason instanceof Error ? reason.message : "日期读取失败。");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [name, operation]);
  const submit = (eventDate?: string | null) => {
    setOperation({ eventDate });
  };
  return (
    <div className="border-t border-border px-5 py-3 text-xs" aria-label="事件日期与采集时间">
      <p>事件日期：{value ? value.eventDate || "未知（未填写）" : "尚未读取"}</p>
      {value && (
        <p className="mt-1 break-words text-muted-foreground">
          {value.captureTimeBasis === "captured" ? "采集时间（只读）" : "历史记录时间（非原始采集凭证）"}：
          <time dateTime={value.capturedAt}>{new Date(value.capturedAt).toLocaleString()}</time>
        </p>
      )}
      <details className="mt-2">
        <summary className="min-h-11 cursor-pointer py-3">设置或纠正事件日期</summary>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft && !validEventDate(draft)) {
              setError("请输入有效的事件日期。");
              return;
            }
            submit(draft || null);
          }}
        >
          <label htmlFor={id} className="w-full">
            事件发生的日历日（可留空；不按时区换算）
          </label>
          <input
            id={id}
            aria-label="事件发生日期"
            type="date"
            min="0001-01-01"
            max="9999-12-31"
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-11 min-w-0 rounded border border-border bg-card px-2"
          />
          <Button size="sm" type="submit" disabled={busy} className="min-h-11">
            保存日期
          </Button>
          <Button size="sm" type="button" variant="outline" disabled={busy} className="min-h-11" onClick={() => submit(null)}>
            清除事件日期
          </Button>
          <p className="w-full text-muted-foreground">只改事件日期，不改正文、原件或采集时间。未知时请留空。</p>
        </form>
      </details>
      {busy && <p role="status">正在读取或保存日期…</p>}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <Button type="button" variant="ghost" onClick={() => submit()}>
            重新读取日期
          </Button>
        </div>
      )}
    </div>
  );
}

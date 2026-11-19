import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { getRequestToken } from "@/connect";
import { validEventDate } from "./eventDates";

export type SourceCandidate = { name: string; label: string; eventDate: string | null; createdAt: string };
export async function findSourceCandidates(
  name: string,
  query: string,
  pageToken: string,
  signal: AbortSignal,
): Promise<{ candidates: SourceCandidate[]; nextPageToken: string }> {
  if (!/^memos\/[a-zA-Z0-9_-]+$/.test(name)) throw new Error("记录标识无效。");
  const token = await getRequestToken();
  signal.throwIfAborted();
  const params = new URLSearchParams({ q: query, pageSize: "10", ...(pageToken ? { pageToken } : {}) });
  const response = await fetch(`/api/youji/memos/${encodeURIComponent(name.slice(6))}/source/candidates?${params}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error("候选来源未能读取，请重新搜索。原有引用不会因此更改。");
  const data = await response.json();
  if (!data || !Array.isArray(data.candidates) || data.candidates.length > 20 || typeof data.nextPageToken !== "string")
    throw new Error("候选响应无效，请重新搜索。");
  const candidates = data.candidates.map((row: SourceCandidate) => {
    if (
      !row ||
      typeof row.name !== "string" ||
      !/^memos\/[a-zA-Z0-9_-]+$/.test(row.name) ||
      row.name === name ||
      typeof row.label !== "string" ||
      row.label.length > 1000 ||
      (row.eventDate !== null && !validEventDate(row.eventDate)) ||
      typeof row.createdAt !== "string" ||
      !Number.isFinite(Date.parse(row.createdAt))
    )
      throw new Error("候选响应无效，请重新搜索。");
    return { name: row.name, label: row.label, eventDate: row.eventDate, createdAt: row.createdAt };
  });
  return { candidates, nextPageToken: data.nextPageToken };
}

export default function SourcePicker({ name, onSelect, onClose }: { name: string; onSelect: (name: string) => void; onClose: () => void }) {
  const id = useId();
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<SourceCandidate[]>([]);
  const [nextPage, setNextPage] = useState("");
  const [selected, setSelected] = useState("");
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    searchInput.current?.focus();
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  const search = async (more: boolean) => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    const currentQuery = more ? query : draft.trim();
    const page = more ? nextPage : "";
    setSelected("");
    setError("");
    setBusy(true);
    setSearched(true);
    if (!more) {
      setRows([]);
      setNextPage("");
      setQuery(currentQuery);
    }
    try {
      const result = await findSourceCandidates(name, currentQuery, page, next.signal);
      if (!alive.current || next.signal.aborted) return;
      setRows((previous) => {
        const merged = new Map((more ? previous : []).map((item) => [item.name, item]));
        for (const item of result.candidates) merged.set(item.name, item);
        return [...merged.values()];
      });
      setNextPage(result.nextPageToken);
    } catch (reason) {
      if (!alive.current || next.signal.aborted) return;
      setRows([]);
      setSelected("");
      setNextPage("");
      setError(reason instanceof Error ? reason.message : "候选读取失败。");
    } finally {
      if (alive.current && !next.signal.aborted) setBusy(false);
    }
  };
  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="搜索并选择私密来源"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
      className="mt-3 min-w-0 rounded border border-border p-3"
    >
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void search(false);
        }}
      >
        <label htmlFor={id} className="w-full">
          来源关键词（可留空列出自己的私密记录）
        </label>
        <input
          id={id}
          ref={searchInput}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (!busy) void search(false);
            }
          }}
          type="search"
          value={draft}
          maxLength={200}
          autoComplete="off"
          onChange={(event) => setDraft(event.target.value)}
          disabled={busy}
          className="min-h-11 min-w-0 flex-1 rounded border border-border bg-card px-2"
        />
        <Button type="submit" size="sm" disabled={busy} className="min-h-11">
          搜索来源
        </Button>
        <Button type="button" size="sm" variant="ghost" className="min-h-11" onClick={onClose}>
          关闭来源选择
        </Button>
      </form>
      {!searched && <p className="mt-2">输入关键词后点击搜索；不会自动读取候选或正文。</p>}
      {busy && <p role="status">正在查找私密来源…</p>}
      {error && (
        <p role="alert" className="mt-2 text-destructive">
          {error}
        </p>
      )}
      {searched && !busy && !error && rows.length === 0 && (
        <p role="status">{nextPage ? "本页没有当前可用来源，可继续加载或重新搜索。" : "没有找到可用私密来源。可更换关键词重新搜索。"}</p>
      )}
      {rows.length > 0 && (
        <form
          className="mt-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (selected && !busy) onSelect(selected);
          }}
        >
          <fieldset disabled={busy}>
            <legend>选择一份来源；相同标题请核对 ID 和日期</legend>
            {rows.map((row) => (
              <label key={row.name} className="mt-2 flex min-h-11 items-start gap-2 rounded border border-border p-3">
                <input
                  type="radio"
                  name={`${id}-candidate`}
                  value={row.name}
                  checked={selected === row.name}
                  onChange={() => setSelected(row.name)}
                  className="mt-1"
                />
                <span className="min-w-0 break-words">
                  <span className="block">{row.label || "未命名记录"}</span>
                  <span className="block break-all">{row.name}</span>
                  <span className="block text-muted-foreground">
                    事件日期：{row.eventDate || "未知"} · 记录创建时间：
                    <time dateTime={row.createdAt}>{new Date(row.createdAt).toLocaleString()}</time>
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={busy || !selected}
              className="min-h-11"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (selected && !busy) onSelect(selected);
                }
              }}
            >
              使用所选来源
            </Button>
          </div>
          <p className="mt-2 text-muted-foreground">
            候选仅含短标题、ID 和日期，不是正文。分页期间记录可能变化；重新搜索可刷新，设置时会再次校验权限。
          </p>
        </form>
      )}
      {nextPage && (
        <Button type="button" variant="outline" size="sm" disabled={busy} className="mt-2 min-h-11" onClick={() => void search(true)}>
          加载更多来源
        </Button>
      )}
    </div>
  );
}

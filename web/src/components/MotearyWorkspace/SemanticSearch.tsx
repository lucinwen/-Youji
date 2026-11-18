import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { getAccessToken } from "@/auth-state";
import { Button } from "@/components/ui/button";
import { authServiceClient } from "@/connect";
import { queryClient } from "@/lib/query-client";

type Result = {
  hits: { name: string; score: number; excerpt: string }[];
  model: string;
  revision: string;
  truncated: boolean;
  snapshot?: string;
  nextOffset?: number;
  scanned?: number;
  total?: number;
  candidateTruncated?: boolean;
  metadataTruncated?: boolean;
  passageTruncated?: boolean;
  skipped?: number;
};
type DisplayResult = Result & { offset: number; query: string };

function MatchedExcerpt({ excerpt, query }: { excerpt: string; query: string }) {
  const index = query ? excerpt.indexOf(query) : -1;
  if (index < 0) return <>{excerpt}</>;
  return (
    <>
      {excerpt.slice(0, index)}
      <mark className="rounded bg-amber-100 text-amber-950 dark:bg-amber-900 dark:text-amber-50">
        {excerpt.slice(index, index + query.length)}
      </mark>
      {excerpt.slice(index + query.length)}
    </>
  );
}

export default function SemanticSearch({ userName, filter }: { userName: string; filter: string }) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<DisplayResult>();
  const controller = useRef<AbortController | null>(null);
  useEffect(
    () =>
      queryClient.getQueryCache().subscribe((event) => {
        // memoKeys.all is ["memos"]; this also receives the existing SSE invalidations.
        if (
          event.query.queryKey[0] !== "memos" ||
          !(event.type === "removed" || (event.type === "updated" && event.action.type === "invalidate"))
        )
          return;
        controller.current?.abort();
        controller.current = null;
        setResult(undefined);
        setBusy(false);
      }),
    [],
  );
  useEffect(() => {
    setResult(undefined);
    setError("");
    setQuery("");
    setBusy(false);
    return () => {
      controller.current?.abort();
      controller.current = null;
    };
  }, [userName, filter]);
  const search = async (next = false) => {
    if (controller.current || !query.trim()) return;
    const offset = next ? result?.nextOffset : 0;
    const snapshot = next ? result?.snapshot : undefined;
    if (next && (offset === undefined || !snapshot)) return;
    const submittedQuery = query.trim();
    const abort = new AbortController();
    controller.current = abort;
    const active = () => controller.current === abort && !abort.signal.aborted;
    setBusy(true);
    setError("");
    setResult(undefined);
    const request = async (path: string, body?: object) => {
      const { user } = await authServiceClient.getCurrentUser({}, { signal: abort.signal });
      abort.signal.throwIfAborted();
      if (user?.name !== userName) throw new Error("账户已变化，请刷新后重试。未发送检索内容。");
      const token = getAccessToken();
      return fetch(path, {
        method: body ? "POST" : "GET",
        credentials: "same-origin",
        cache: "no-store",
        signal: abort.signal,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    };
    try {
      const processor = await request("/api/youji/retrieval/processor");
      if (processor.status === 503) throw new Error("本地语义模型未配置或校验未通过，仍可使用上方关键词搜索。");
      if (processor.status === 429) throw new Error("本地语义模型正忙，请稍后重试；仍可使用关键词搜索。");
      if (!processor.ok) throw new Error("无法检查语义服务，请稍后重试；仍可使用关键词搜索。");
      const availability = await processor.json();
      if (!availability.available) throw new Error("本地语义模型未配置或不可用，仍可使用上方关键词搜索。");
      abort.signal.throwIfAborted();
      const response = await request("/api/youji/retrieval/search", {
        query: submittedQuery,
        filter,
        offset,
        ...(snapshot ? { snapshot } : {}),
      });
      if (response.status === 503) throw new Error("本地语义模型未配置或不可用，仍可使用上方关键词搜索。");
      if (response.status === 429) throw new Error("本地语义模型正忙，请稍后重试；仍可使用关键词搜索。");
      if (response.status === 409) throw new Error("记录快照已变化，分页与结果已清除。请点击“尝试语义找回”从第一批重新开始。");
      if (response.status === 504) throw new Error("本地语义找回超时或已取消，请稍后重试。");
      if (!response.ok) throw new Error("语义找回失败，请稍后重试；仍可使用关键词搜索。");
      const data = (await response.json()) as Result;
      if (
        !Array.isArray(data.hits) ||
        data.hits.length > 5 ||
        typeof data.model !== "string" ||
        typeof data.revision !== "string" ||
        typeof data.truncated !== "boolean" ||
        (data.snapshot !== undefined && (typeof data.snapshot !== "string" || !data.snapshot)) ||
        [data.scanned, data.total, data.skipped].some((value) => value !== undefined && (!Number.isSafeInteger(value) || value < 0)) ||
        (data.nextOffset !== undefined && (!Number.isSafeInteger(data.nextOffset) || data.nextOffset <= (offset ?? 0) || !data.snapshot)) ||
        [data.candidateTruncated, data.passageTruncated, data.metadataTruncated].some(
          (value) => value !== undefined && typeof value !== "boolean",
        ) ||
        data.hits.some(
          (hit) =>
            !hit ||
            typeof hit.name !== "string" ||
            !/^memos\/[^/]+$/.test(hit.name) ||
            typeof hit.excerpt !== "string" ||
            typeof hit.score !== "number" ||
            !Number.isFinite(hit.score),
        )
      )
        throw new Error("语义服务返回格式异常，请使用关键词搜索。");
      if (active()) setResult({ ...data, offset: offset ?? 0, query: submittedQuery });
    } catch (cause) {
      if (active()) setError(cause instanceof Error ? cause.message : "语义找回失败，请使用关键词搜索。");
    } finally {
      if (active()) {
        controller.current = null;
        setBusy(false);
      }
    }
  };
  return (
    <section aria-label="实验性语义找回" className="mb-4 rounded-xl border border-border bg-card p-4">
      <h3 className="text-sm font-medium">相关片段候选 · 实验功能</h3>
      <p className="my-2 text-xs leading-6 text-muted-foreground">
        仅在点击后发送查询到当前有记服务器，由本地模型处理，不发送云端。沿用当前工作台的分类、来源、日期和空间范围，每批最多比较 100
        条候选，最多枚举 5000 条记录。 每批最多返回 5
        条相近记录，不是全库排名。跨语言查询可能漏找。相关不代表事实，不保证找全或一定有结果；分数是相似度，不是概率。原关键词搜索结果保持不变。
      </p>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <input
          aria-label="语义找回描述"
          value={query}
          maxLength={200}
          disabled={busy}
          className="min-w-0 flex-1 rounded border border-border px-3 py-2 text-sm"
          onChange={(event) => {
            setQuery(event.target.value);
            setResult(undefined);
            setError("");
          }}
        />
        <Button type="submit" variant="outline" disabled={busy || !query.trim()}>
          尝试语义找回
        </Button>
        {busy && (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              controller.current?.abort();
              controller.current = null;
              setBusy(false);
              setResult(undefined);
              setError("已取消语义找回，仍可使用关键词搜索。");
            }}
          >
            取消语义找回
          </Button>
        )}
      </form>
      {busy && (
        <p role="status" className="mt-2 text-xs">
          正在检查本地模型并查找相关记录…
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs">
          {error}
        </p>
      )}
      {result && (
        <div className="mt-3 space-y-3">
          <p className="rounded border border-amber-500/50 bg-amber-100/40 p-3 text-sm font-medium dark:bg-amber-900/20">
            这些是相近候选，可能没有答案。请核对原文。
          </p>
          <p className="break-all text-xs">
            模型：{result.model} · 版本：{result.revision}
          </p>
          {result.scanned !== undefined && result.total !== undefined && (
            <p className="text-xs">
              本批覆盖 {result.scanned > result.offset ? result.offset + 1 : result.offset} 至 {result.scanned}；当前候选清单共{" "}
              {result.total} 条。因处理预算跳过 {result.skipped ?? 0} 条。本清单不是全库事务快照。
            </p>
          )}
          {result.nextOffset !== undefined && <p className="text-xs">全范围尚未检索完；继续检索会替换本批结果，不合并旧候选。</p>}
          {(result.candidateTruncated || (result.truncated && result.snapshot === undefined)) && (
            <p className="text-xs">候选已截断，未覆盖此范围全部记录；请缩小范围或使用关键词搜索。</p>
          )}
          {result.metadataTruncated && (
            <p className="text-xs">候选清单达到 5000 条上限，更早资料未包含在清单中。请缩小日期或分类范围后重新检索。</p>
          )}
          {result.passageTruncated && <p className="text-xs">部分正文被截断，本次仅比较其已截取片段，请打开完整原文核对。</p>}
          {result.hits.length === 0 && (
            <p role="status" className="text-xs">
              {result.total === 0 ? "当前范围没有候选记录。" : "本批没有可比较正文或没有返回候选。"}
              这不是模型判断没有答案，可继续使用关键词搜索。
            </p>
          )}
          {result.hits.map((hit) => (
            <article key={hit.name} className="rounded border border-border p-3">
              <Link className="text-xs underline" to={`/memos/${encodeURIComponent(hit.name.slice(6))}`}>
                打开原记录 · {hit.name}
              </Link>
              <p className="text-xs">模型相似匹配 · 请核对原文</p>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm">
                <MatchedExcerpt excerpt={hit.excerpt} query={result.query} />
              </p>
              <p className="mt-2 text-[11px] text-muted-foreground">相似度 {hit.score.toFixed(3)}（非概率，非置信度）</p>
            </article>
          ))}
          {result.nextOffset !== undefined && (
            <Button type="button" variant="outline" disabled={busy} onClick={() => void search(true)}>
              继续检索更早资料
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

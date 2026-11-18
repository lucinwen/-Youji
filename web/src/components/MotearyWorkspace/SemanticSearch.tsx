import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { getAccessToken } from "@/auth-state";
import { Button } from "@/components/ui/button";
import { authServiceClient } from "@/connect";
import { queryClient } from "@/lib/query-client";

type Result = { hits: { name: string; score: number; excerpt: string }[]; model: string; revision: string; truncated: boolean };

export default function SemanticSearch({ userName, filter }: { userName: string; filter: string }) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result>();
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
  const search = async () => {
    if (controller.current || !query.trim()) return;
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
      if (processor.status === 503) throw new Error("本地语义模型未配置，仍可使用上方关键词搜索。");
      if (!processor.ok) throw new Error("无法检查语义服务，请稍后重试；仍可使用关键词搜索。");
      const availability = await processor.json();
      if (!availability.available) throw new Error("本地语义模型未配置或不可用，仍可使用上方关键词搜索。");
      abort.signal.throwIfAborted();
      const response = await request("/api/youji/retrieval/search", { query: query.trim(), filter });
      if (response.status === 503) throw new Error("本地语义模型未配置或不可用，仍可使用上方关键词搜索。");
      if (response.status === 429) throw new Error("本地语义模型正忙，请稍后重试；仍可使用关键词搜索。");
      if (response.status === 409) throw new Error("记录已变化，结果已丢弃，请重新查找。");
      if (response.status === 504) throw new Error("本地语义找回超时或已取消，请稍后重试。");
      if (!response.ok) throw new Error("语义找回失败，请稍后重试；仍可使用关键词搜索。");
      const data = (await response.json()) as Result;
      if (
        !Array.isArray(data.hits) ||
        data.hits.length > 5 ||
        typeof data.model !== "string" ||
        typeof data.revision !== "string" ||
        typeof data.truncated !== "boolean" ||
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
      if (active()) setResult(data);
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
      <h3 className="text-sm font-medium">近义 / 跨语言找回 · 实验功能</h3>
      <p className="my-2 text-xs leading-6 text-muted-foreground">
        仅在点击后发送查询到当前有记服务器，由本地模型处理，不发送云端。沿用当前工作台的分类、来源、日期和空间范围，最多比较 100 条候选。
        最多返回 5
        条相近记录，也可能不相关，请打开原文核对。相关不代表事实，不保证找全或一定有结果；分数是相似度，不是概率。原关键词搜索结果保持不变。
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
          onChange={(event) => setQuery(event.target.value)}
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
          <p className="break-all text-xs">
            模型：{result.model} · 版本：{result.revision}
          </p>
          {result.truncated && <p className="text-xs">候选已截断，未覆盖此范围全部记录；请缩小范围或使用关键词搜索。</p>}
          {result.hits.length === 0 && (
            <p role="status" className="text-xs">
              未找到相关记录；这不代表资料不存在，可继续使用关键词搜索。
            </p>
          )}
          {result.hits.map((hit) => (
            <article key={hit.name} className="rounded border border-border p-3">
              <Link className="text-xs underline" to={`/memos/${encodeURIComponent(hit.name.slice(6))}`}>
                打开原记录 · {hit.name}
              </Link>
              <p className="text-xs text-muted-foreground">相似度 {hit.score.toFixed(3)}（非概率）</p>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm">{hit.excerpt}</p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

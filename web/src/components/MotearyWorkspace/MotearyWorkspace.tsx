import {
  ArrowDownIcon,
  ArrowRightIcon,
  BookOpenIcon,
  CheckIcon,
  FileAudioIcon,
  ImageIcon,
  LinkIcon,
  LoaderCircleIcon,
  MessageSquareIcon,
  PaperclipIcon,
  PenLineIcon,
  PodcastIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  SproutIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { MemoEditor } from "@/components/MemoEditor";
import { Button } from "@/components/ui/button";
import { useSpaceContext } from "@/contexts/SpaceContext";
import { useInfiniteMemos } from "@/hooks/useMemoQueries";
import { cn } from "@/lib/utils";
import { ROUTES } from "@/router/routes";
import { State } from "@/types/proto/api/common_pb";
import { type Memo, Visibility } from "@/types/proto/api/memo_service_pb";
import BatchImport from "./BatchImport";
import {
  buildCaptureStarter,
  buildSourceFilter,
  CATEGORY_LABELS,
  type CaptureCategory,
  getSourceKind,
  getSourceTitle,
  getSourceVisibility,
  SOURCE_INFO,
  SOURCE_KINDS,
  type SourceKind,
} from "./sources";

const SOURCE_ICONS = {
  text: PenLineIcon,
  link: LinkIcon,
  podcast: PodcastIcon,
  conversation: MessageSquareIcon,
  image: ImageIcon,
  file: FileAudioIcon,
};
const categories = Object.entries(CATEGORY_LABELS) as [CaptureCategory, string][];
const memoPath = (name: string) => `/memos/${encodeURIComponent(name.split("/").at(-1) ?? "")}`;

function SourceCard({ memo }: { memo: Memo }) {
  const kind = getSourceKind(memo);
  const Icon = kind === "unknown" ? BookOpenIcon : SOURCE_ICONS[kind];
  const date = memo.createTime ? new Date(Number(memo.createTime.seconds) * 1000).toLocaleDateString("zh-CN") : "日期未提供";
  return (
    <Link
      to={memoPath(memo.name)}
      data-testid="moteary-source-record"
      className="group flex min-w-0 flex-col rounded-xl border border-border/70 bg-card p-5 transition-colors hover:border-emerald-700/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <div className="mb-4 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="flex min-w-0 items-center gap-2">
          <Icon className="size-3.5 shrink-0" />
          {kind === "unknown" ? "来源未标记" : SOURCE_INFO[kind].label}
        </span>
        <span>{date}</span>
      </div>
      <p className="mb-2 text-xs text-muted-foreground" aria-label="记录可见范围">
        {getSourceVisibility(memo.visibility)}
      </p>
      <h3 className="mb-4 line-clamp-2 min-h-12 break-words text-[15px] leading-6 font-medium">{getSourceTitle(memo.content)}</h3>
      {memo.attachments.length > 0 && (
        <div className="mb-3 text-xs leading-5 text-muted-foreground" aria-label="附件与检索范围">
          <p>附件已关联，不代表内容已解析。PDF、音频、图片不会自动提取、转写或 OCR。</p>
          <p>可搜索已保存正文、批注及正文中的文件名；不能搜索未解析附件内部内容。</p>
          <ul className="mt-1 break-all">
            {memo.attachments.map((attachment) => (
              <li key={attachment.name}>
                {attachment.filename}
                {attachment.filename.endsWith(".original.zip") ? " · 原件归档" : ""}
              </li>
            ))}
          </ul>
          <span className="underline">打开记录查看附件并取回原件</span>
        </div>
      )}
      <div className="mt-auto flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <CheckIcon className="size-3" />
          服务端记录
        </span>
        {memo.attachments.length > 0 && (
          <span className="inline-flex items-center gap-1">
            <PaperclipIcon className="size-3" />
            {memo.attachments.length} 个关联附件
          </span>
        )}
        <ArrowRightIcon className="ms-auto size-3.5 transition-transform group-hover:translate-x-0.5" />
      </div>
    </Link>
  );
}

export default function MotearyWorkspace({ userName }: { userName: string }) {
  const { spaces, isLoadingSpaces, isSpacesError } = useSpaceContext();
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<CaptureCategory | "all">("all");
  const [spaceName, setSpaceName] = useState("");
  const [capture, setCapture] = useState<{ kind: SourceKind; category: CaptureCategory; space?: string } | null>(null);
  const [captureCategory, setCaptureCategory] = useState<CaptureCategory>("idea");
  const [isSaving, setIsSaving] = useState(false);
  const [savedName, setSavedName] = useState<string>();
  const listRef = useRef<HTMLElement>(null);
  const query = useInfiniteMemos({
    filter: buildSourceFilter(userName, category, spaceName || undefined, search),
    pageSize: 24,
    state: State.NORMAL,
    orderBy: "create_time desc",
  });
  const memos = query.data?.pages.flatMap((page) => page.memos) ?? [];
  const activeSpace = spaces.find((space) => space.name === spaceName);
  const spaceUnavailable = !!spaceName && !activeSpace;

  const openCapture = (kind: SourceKind) => {
    if (capture || spaceUnavailable) return;
    setSavedName(undefined);
    setCapture({ kind, category: captureCategory, space: spaceName || undefined });
  };

  return (
    <div className="w-full min-w-0 bg-[#f5f3ec] text-[#223831] dark:bg-background dark:text-foreground" data-testid="moteary-workspace">
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8 lg:px-12 lg:py-9">
        <header className="mb-9 flex flex-wrap items-center justify-between gap-4 border-b border-[#263e3320] pb-5 dark:border-border">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-xl bg-[#203e32] text-[#eee6cf]">
              <SproutIcon className="size-6" strokeWidth={1.5} />
            </span>
            <div>
              <div className="text-xl font-semibold tracking-[0.12em]">拾微</div>
              <div className="text-[9px] tracking-[0.24em] text-muted-foreground">MOTEARY · 个人素材工作台</div>
            </div>
          </div>
          <Link to={ROUTES.HOME} className="flex items-center gap-2 text-xs text-muted-foreground underline-offset-4 hover:underline">
            回到 Memos 时间线
            <ArrowRightIcon className="size-3.5" />
          </Link>
        </header>

        <section className="mb-9 grid gap-7 lg:grid-cols-[1.45fr_1fr] lg:items-end" aria-labelledby="moteary-heading">
          <div>
            <p className="mb-4 flex items-center gap-2 text-[10px] tracking-[0.18em] text-[#897149] dark:text-amber-200/75">
              <span className="h-px w-5 bg-current" />
              从一个片段开始
            </p>
            <h1 id="moteary-heading" className="max-w-xl text-3xl leading-[1.45] font-medium tracking-tight sm:text-4xl">
              让过去留下的片段，
              <br />
              <span className="text-[#6b7c65] dark:text-emerald-200/70">再次对自己有用</span>
            </h1>
            <p className="mt-4 max-w-lg text-sm leading-7 text-muted-foreground">
              先保留材料和当时的想法，不急着整理成答案。
              <br className="hidden sm:block" />
              一段生活、一句原话，或一闪而过的灵感。
            </p>
            <button
              type="button"
              onClick={() => listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
              className="mt-5 inline-flex items-center gap-2 text-xs font-medium underline-offset-4 hover:underline"
            >
              回看我的片段
              <ArrowDownIcon className="size-3.5" />
            </button>
          </div>
          <aside
            className="rounded-2xl border border-[#d8dacd] bg-[#eceee3]/70 p-5 dark:border-border dark:bg-muted/35"
            aria-label="记录原则"
          >
            <div className="mb-4 flex items-center gap-2 text-xs font-medium">
              <ShieldCheckIcon className="size-4" />
              让来源清楚，让自己的声音留下
            </div>
            <div className="space-y-3 text-xs leading-5 text-muted-foreground">
              <p>
                <span className="me-2 text-[#927744] dark:text-amber-200/75">01</span>原始材料与我的批注分开保存。
              </p>
              <p>
                <span className="me-2 text-[#927744] dark:text-amber-200/75">02</span>来源标签由你填写，不是内容核验结论。
              </p>
              <p>
                <span className="me-2 text-[#927744] dark:text-amber-200/75">03</span>保存材料，不等于提取或 AI 处理完成。
              </p>
            </div>
          </aside>
        </section>

        <BatchImport
          key={userName}
          userName={userName}
          onSaved={() => {
            void query.refetch();
          }}
        />

        <section aria-labelledby="capture-heading" className="mb-9">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="mb-1 text-[10px] tracking-[0.15em] text-muted-foreground">CAPTURE</p>
              <h2 id="capture-heading" className="text-lg font-semibold">
                现在，拾起一点什么
              </h2>
            </div>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              新片段分类
              <select
                aria-label="新片段分类"
                value={captureCategory}
                disabled={!!capture}
                onChange={(event) => setCaptureCategory(event.target.value as CaptureCategory)}
                className="max-w-40 rounded-lg border border-border bg-card px-3 py-2 text-foreground disabled:opacity-50"
              >
                {categories.map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
            {SOURCE_KINDS.map((kind) => {
              const Icon = SOURCE_ICONS[kind];
              const active = capture?.kind === kind;
              return (
                <button
                  key={kind}
                  type="button"
                  data-testid={`moteary-capture-${kind}`}
                  disabled={!!capture || spaceUnavailable}
                  aria-pressed={active}
                  onClick={() => openCapture(kind)}
                  className={cn(
                    "group flex min-w-0 flex-col items-start rounded-xl border bg-card p-4 text-start transition-colors hover:border-emerald-700/40 hover:bg-emerald-50/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-50 dark:hover:bg-muted",
                    active ? "border-emerald-800/50 disabled:opacity-100" : "border-border/70",
                  )}
                >
                  <Icon className="mb-5 size-5 text-[#6b7c65] dark:text-emerald-200/70" strokeWidth={1.5} />
                  <span className="text-sm font-medium">{SOURCE_INFO[kind].label}</span>
                  <span className="mt-1 text-[11px] leading-5 text-muted-foreground">{SOURCE_INFO[kind].description}</span>
                </button>
              );
            })}
          </div>
          <p className="mt-3 text-[11px] leading-5 text-muted-foreground">
            分类只是内容标签，不改变权限。当前范围：{activeSpace ? activeSpace.title : "我的全部空间"}
            。新记录的空间与可见范围请在保存前核对。
          </p>
          {capture && (
            <div className="mt-5 rounded-2xl border border-emerald-800/20 bg-card p-4 sm:p-5" data-testid="moteary-composer">
              <div className="mb-4 border-b border-border pb-4">
                <h3 className="mb-2 text-sm font-medium">
                  {SOURCE_INFO[capture.kind].label} · {CATEGORY_LABELS[capture.category]}
                </h3>
                <p className="text-xs leading-6 text-muted-foreground">{SOURCE_INFO[capture.kind].instruction}</p>
                <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                  若有未完成的草稿，会优先恢复原草稿。草稿不是已保存记录；保存成功才会出现在下方列表。取消会保留草稿。新建个人片段默认仅自己可见，空间片段默认空间成员可见；恢复草稿保留原可见范围，请保存前核对。
                </p>
              </div>
              <MemoEditor
                draft={{
                  scope: `moteary:${capture.kind}:${capture.category}`,
                  space: capture.space,
                  visibility: capture.space ? Visibility.SPACE : Visibility.PRIVATE,
                  content: buildCaptureStarter(capture.kind, capture.category),
                }}
                autoFocus
                frameless
                onSavingChange={setIsSaving}
                onCancel={() => {
                  if (!isSaving) setCapture(null);
                }}
                onConfirm={(name) => {
                  setSavedName(name);
                  setCapture(null);
                  setIsSaving(false);
                  void query.refetch();
                }}
              />
            </div>
          )}
          {savedName && (
            <div
              role="status"
              className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-emerald-800/15 bg-emerald-100/30 px-4 py-3 text-xs dark:bg-emerald-900/15"
            >
              <CheckIcon className="size-4" />
              已保存到当前 Memos 实例。
              <Link to={memoPath(savedName)} className="underline underline-offset-4">
                查看这份记录
              </Link>
              <span className="text-muted-foreground">如果修改了标签，记录可能不在当前筛选中。</span>
            </div>
          )}
        </section>

        <section ref={listRef} className="scroll-mt-5" aria-labelledby="sources-heading">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="mb-1 text-[10px] tracking-[0.15em] text-muted-foreground">COLLECTION</p>
              <h2 id="sources-heading" className="text-lg font-semibold">
                我的来源片段
              </h2>
            </div>
            <div className="flex max-w-full items-center gap-2">
              <select
                aria-label="来源空间"
                value={spaceName}
                disabled={!!capture || isLoadingSpaces || isSpacesError}
                onChange={(event) => setSpaceName(event.target.value)}
                className="min-w-0 max-w-48 rounded-lg border border-border bg-card px-3 py-2 text-xs disabled:opacity-50"
              >
                <option value="">我的全部空间</option>
                {spaces.map((space) => (
                  <option key={space.name} value={space.name}>
                    {space.title} · {space.name.split("/").at(-1)}
                  </option>
                ))}
              </select>
              <Button variant="outline" size="icon" aria-label="刷新来源" disabled={query.isFetching} onClick={() => void query.refetch()}>
                <RefreshCwIcon className={cn("size-3.5", query.isFetching && "animate-spin")} />
              </Button>
            </div>
          </div>
          <form
            className="mb-4 flex flex-wrap gap-2"
            aria-label="搜索我的资料"
            onSubmit={(event) => {
              event.preventDefault();
              setSearch(searchDraft.trim());
            }}
          >
            <input
              type="search"
              aria-label="资料关键词"
              value={searchDraft}
              maxLength={200}
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder="查找原文、文件名或我的批注"
              className="min-w-0 flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm"
            />
            <Button type="submit" variant="outline">
              搜索资料
            </Button>
            {(search || searchDraft) && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setSearch("");
                  setSearchDraft("");
                }}
              >
                清除搜索
              </Button>
            )}
            <p className="w-full text-xs text-muted-foreground">
              仅在当前账户和所选分类、空间内搜索已保存正文。PDF、音频和图片的附件内部内容尚不可搜索；可以搜索已填写到正文的文件名或批注。关键词不保存在网址或浏览器存储中。
            </p>
          </form>
          {isSpacesError && (
            <p role="alert" className="mb-3 text-xs text-destructive">
              空间列表未能读取，暂不可切换。请刷新页面重试；不会把失败当作没有空间。
            </p>
          )}
          {spaceUnavailable && (
            <p role="alert" className="mb-3 text-xs text-destructive">
              所选空间当前不可用。请选择其他范围后再新建记录。
            </p>
          )}
          <div className="mb-5 flex flex-wrap gap-1.5" aria-label="来源分类">
            {([["all", "全部"], ...categories] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={category === key}
                onClick={() => setCategory(key)}
                className={cn(
                  "rounded-full px-3.5 py-1.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                  category === key
                    ? "bg-[#294536] text-[#f5f3ec] dark:bg-emerald-100 dark:text-emerald-950"
                    : "text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mb-4 text-[11px] leading-5 text-muted-foreground">
            仅显示我创建、带 #拾微 标签的未归档记录。
            {query.isFetching
              ? "正在向服务器核对…"
              : query.isError
                ? "未能核对最新状态。"
                : `当前已加载 ${memos.length} 条${query.hasNextPage ? "，还有更多" : ""}。`}
            其他记录仍在原时间线。
          </p>
          {query.isError && (
            <div role="alert" className="mb-4 rounded-xl border border-destructive/30 bg-card p-4 text-sm">
              <p className="mb-2">来源读取失败。已显示的记录可能不是最新状态；不会将失败显示成空收藏。</p>
              <Button size="sm" variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>
                重新读取
              </Button>
            </div>
          )}
          {query.isPending ? (
            <div role="status" className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <LoaderCircleIcon className="size-4 animate-spin" />
              正在读取你的片段…
            </div>
          ) : memos.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {memos.map((memo) => (
                <SourceCard key={memo.name} memo={memo} />
              ))}
            </div>
          ) : (
            !query.isError && (
              <div
                className="rounded-2xl border border-dashed border-[#bfc8b9] px-6 py-12 text-center dark:border-border"
                data-testid="moteary-empty"
              >
                <SproutIcon className="mx-auto mb-4 size-7 text-[#8a997a]" strokeWidth={1.3} />
                <h3 className="mb-2 text-sm font-medium">{search ? "当前范围未找到匹配资料" : "这里，留给你自己的片段"}</h3>
                <p className="text-xs leading-6 text-muted-foreground">
                  {search
                    ? "可以换一个关键词，或清除搜索后检查分类、空间。没有匹配结果不代表资料已丢失。未解析的 PDF、音频与图片内部内容暂不能搜索，请尝试文件名或批注。"
                    : "这个范围还没有记录。选择上方任一种来源，写下第一条。不需要完整，也不需要马上有用。"}
                </p>
              </div>
            )
          )}
          {query.hasNextPage && (
            <div className="mt-5 text-center">
              <Button variant="outline" disabled={query.isFetching} onClick={() => void query.fetchNextPage()}>
                {query.isFetchingNextPage ? "正在读取…" : "加载更多片段"}
              </Button>
            </div>
          )}
        </section>

        <footer className="mt-9 border-t border-[#263e3320] pt-5 pb-2 dark:border-border">
          <p className="text-[11px] leading-6 text-muted-foreground">
            保存位置：当前 Memos 实例 · 本设备离线可用性未验证 · 本工作台不自动触发提取或 AI 整理
          </p>
          <p className="mt-1 text-[11px] leading-6 text-muted-foreground">
            普通图片上传可能处理图像，不保证原始字节不变。原有转写与处理结果请在记录或附件详情查看。拾微工作台基于完整
            Memos，原有时间线、搜索、附件与空间功能保留。
          </p>
        </footer>
      </div>
    </div>
  );
}

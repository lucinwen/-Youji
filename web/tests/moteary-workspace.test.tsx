import { create } from "@bufbuild/protobuf";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoEditorDraftProps } from "@/components/MemoEditor/MemoEditor";
import MotearyWorkspace from "@/components/MotearyWorkspace/MotearyWorkspace";
import { MemoSchema, Visibility } from "@/types/proto/api/memo_service_pb";

const { query, useInfiniteMemos, spaces, editorProps } = vi.hoisted(() => ({
  query: {
    data: { pages: [{ memos: [] as unknown[] }] },
    isPending: false,
    isError: false,
    isFetching: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
  },
  useInfiniteMemos: vi.fn(),
  spaces: { spaces: [{ name: "spaces/one", title: "My space" }], isLoadingSpaces: false, isSpacesError: false },
  editorProps: { current: undefined as MemoEditorDraftProps | undefined },
}));
vi.mock("@/hooks/useMemoQueries", () => ({ useInfiniteMemos }));
vi.mock("@/contexts/SpaceContext", () => ({ useSpaceContext: () => spaces }));
vi.mock("@/components/MemoEditor", () => ({
  MemoEditor: (props: MemoEditorDraftProps) => {
    editorProps.current = props;
    return (
      <div data-testid="original-memo-editor">
        <button type="button" onClick={() => props.onCancel?.()}>
          Cancel draft
        </button>
        <button type="button" onClick={() => props.onConfirm?.("memos/saved")}>
          Confirm saved
        </button>
      </div>
    );
  },
}));
const mount = () =>
  render(
    <MemoryRouter>
      <MotearyWorkspace userName="users/alice" />
    </MemoryRouter>,
  );

describe("Moteary workspace state boundaries", () => {
  beforeEach(() => {
    query.data = { pages: [{ memos: [] }] };
    query.isPending = false;
    query.isError = false;
    query.isFetching = false;
    query.hasNextPage = false;
    spaces.isSpacesError = false;
    editorProps.current = undefined;
    vi.clearAllMocks();
    useInfiniteMemos.mockReturnValue(query);
  });
  afterEach(cleanup);
  it("puts quick capture before folded import panels and opens audio through the shortcut", () => {
    mount();
    const quick = screen.getByTestId("moteary-capture-text");
    const audio = document.getElementById("audio-import") as HTMLDetailsElement;
    expect(quick.compareDocumentPosition(audio) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(audio.open).toBe(false);
    // Closed details retains the mounted form; jsdom does not model native collapsed visibility.
    expect(screen.getByLabelText("人工校订稿")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "音频与校订" }));
    expect(audio.open).toBe(true);
    expect(screen.getByRole("button", { name: "保存音频与校订稿" })).toBeInTheDocument();
  });
  it("keeps edited audio text mounted while its panel is folded", () => {
    mount();
    fireEvent.click(screen.getByRole("link", { name: "音频与校订" }));
    const text = screen.getByLabelText("人工校订稿");
    fireEvent.change(text, { target: { value: "尚未保存的合成校订" } });
    const panel = document.getElementById("audio-import") as HTMLDetailsElement;
    panel.open = false;
    fireEvent(panel, new Event("toggle"));
    expect(text).toHaveValue("尚未保存的合成校订");
    fireEvent.click(screen.getByRole("link", { name: "音频与校订" }));
    expect(screen.getByLabelText("人工校订稿")).toBe(text);
  });
  it("keeps source and dates when submitting a keyword with advanced controls folded", () => {
    mount();
    const summary = screen.getByText("更多筛选（来源和日期）");
    fireEvent.click(summary);
    fireEvent.change(screen.getByLabelText("找回来源类型"), { target: { value: "podcast" } });
    fireEvent.change(screen.getByLabelText("保存起始日期"), { target: { value: "2026-11-01" } });
    fireEvent.submit(screen.getByRole("form", { name: "搜索我的资料" }));
    fireEvent.click(summary);
    fireEvent.change(screen.getByLabelText("资料关键词"), { target: { value: "新关键词" } });
    fireEvent.submit(screen.getByRole("form", { name: "搜索我的资料" }));
    expect(useInfiniteMemos.mock.lastCall?.[0].filter).toContain('tag in ["source/podcast"]');
    expect(useInfiniteMemos.mock.lastCall?.[0].filter).toContain("created_ts >= timestamp(");
    expect(useInfiniteMemos.mock.lastCall?.[0].filter).toContain("新关键词");
    expect(screen.getByLabelText("已应用找回条件")).toHaveTextContent("播客片段");
  });

  it("queries only the current creator, with supported sort and real pagination", () => {
    mount();
    expect(useInfiniteMemos).toHaveBeenCalledWith(
      expect.objectContaining({ filter: '(creator == "users/alice") && (tag in ["拾微"])', orderBy: "create_time desc", pageSize: 24 }),
    );
    expect(screen.getByTestId("moteary-empty")).toBeInTheDocument();
    expect(screen.getByText(/本设备离线可用性未验证/)).toBeInTheDocument();
  });
  it("shows the Youji brand while preserving the historical collection tag and draft identity", () => {
    mount();
    expect(screen.getByText("有记")).toBeInTheDocument();
    expect(screen.getByText("Youji · 个人素材工作台")).toBeInTheDocument();
    expect(useInfiniteMemos.mock.lastCall?.[0].filter).toContain('tag in ["拾微"]');
    fireEvent.click(screen.getByTestId("moteary-capture-text"));
    expect(editorProps.current?.draft.scope).toBe("moteary:text:idea");
    expect(editorProps.current?.draft.content).toContain("#拾微");
  });
  it("offers recovery outside the tagged collection even when no tagged records remain", () => {
    const RecoveryDestination = () => {
      const location = useLocation();
      return <p data-testid="recovery-destination">{location.pathname + location.search}</p>;
    };
    render(
      <MemoryRouter initialEntries={["/moteary"]}>
        <Routes>
          <Route path="/moteary" element={<MotearyWorkspace userName="users/alice" />} />
          <Route path="/" element={<RecoveryDestination />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("来源空间"), { target: { value: "spaces/one" } });
    fireEvent.change(screen.getByLabelText("资料关键词"), { target: { value: "missing record" } });
    fireEvent.submit(screen.getByRole("form", { name: "搜索我的资料" }));
    expect(screen.getByTestId("moteary-empty")).toBeInTheDocument();
    expect(screen.getByLabelText("找回其他记录")).toHaveTextContent("但不会因此删除");
    expect(screen.getByRole("link", { name: "查看我的归档记录" })).toHaveAttribute("href", "/archived");
    fireEvent.click(screen.getByRole("link", { name: "查看全部个人记录" }));
    expect(screen.getByTestId("recovery-destination")).toHaveTextContent(/^\/$/);
  });
  it("never labels query failure as an empty collection or a successful refresh", () => {
    query.isError = true;
    mount();
    expect(screen.queryByTestId("moteary-empty")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("来源读取失败");
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    expect(query.refetch).toHaveBeenCalledOnce();
  });
  it("keeps stale records visible but flags failed revalidation", () => {
    query.isError = true;
    query.data.pages[0].memos = [create(MemoSchema, { name: "memos/one", content: "A real server response", tags: ["拾微"] })];
    mount();
    expect(screen.getByTestId("moteary-source-record")).toHaveAttribute("href", "/memos/one");
    expect(screen.getByText("来源未标记")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
  it("does not show a premature empty state while loading", () => {
    query.isPending = true;
    mount();
    expect(screen.queryByTestId("moteary-empty")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("正在读取");
  });
  it("opens the real editor contract with a stable scoped starter and protects it from repeated clicks", () => {
    mount();
    fireEvent.change(screen.getByLabelText("新片段分类"), { target: { value: "reference" } });
    fireEvent.change(screen.getByLabelText("来源空间"), { target: { value: "spaces/one" } });
    fireEvent.click(screen.getByTestId("moteary-capture-link"));
    expect(editorProps.current?.draft).toEqual(
      expect.objectContaining({
        scope: "moteary:link:reference",
        space: "spaces/one",
        visibility: Visibility.SPACE,
        content: expect.stringContaining("#拾微 #reference #source/link"),
      }),
    );
    expect(screen.getByTestId("moteary-capture-link")).toBeDisabled();
    expect(screen.getByTestId("moteary-capture-text")).toBeDisabled();
    expect(screen.getByLabelText("新片段分类")).toBeDisabled();
    expect(screen.getByLabelText("来源空间")).toBeDisabled();
    expect(screen.getAllByTestId("original-memo-editor")).toHaveLength(1);
  });
  it("starts personal source capture with a private audience seed", () => {
    mount();
    fireEvent.click(screen.getByTestId("moteary-capture-text"));
    expect(editorProps.current?.draft.visibility).toBe(Visibility.PRIVATE);
    expect(screen.getByText(/新建个人片段默认仅自己可见/)).toBeInTheDocument();
  });
  it("cancel closes without reporting a successful save", () => {
    mount();
    fireEvent.click(screen.getByTestId("moteary-capture-text"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel draft" }));
    expect(screen.queryByTestId("moteary-composer")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(query.refetch).not.toHaveBeenCalled();
  });
  it("only reports a server save after the original editor confirms and refreshes the list", () => {
    mount();
    fireEvent.click(screen.getByTestId("moteary-capture-text"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm saved" }));
    expect(screen.getByRole("status")).toHaveTextContent("已保存到当前 Memos 实例");
    expect(screen.getByRole("link", { name: "查看这份记录" })).toHaveAttribute("href", "/memos/saved");
    expect(screen.queryByTestId("moteary-composer")).not.toBeInTheDocument();
    expect(query.refetch).toHaveBeenCalledOnce();
  });
  it("keeps a saved record reachable when the active podcast and past-date filters exclude it", () => {
    mount();
    expect(screen.getByRole("option", { name: "所有类型（本工作台内）" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("找回来源类型"), { target: { value: "podcast" } });
    fireEvent.change(screen.getByLabelText("保存结束日期"), { target: { value: "2020-01-01" } });
    fireEvent.submit(screen.getByRole("form", { name: "搜索我的资料" }));
    const applied = useInfiniteMemos.mock.lastCall?.[0].filter;
    fireEvent.click(screen.getByTestId("moteary-capture-text"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm saved" }));
    expect(screen.getByRole("status", { name: "记录保存结果" })).toHaveTextContent(
      "当前来源、日期、分类、空间或关键词筛选可能不包含新记录",
    );
    expect(screen.getByRole("link", { name: "查看这份记录" })).toHaveAttribute("href", "/memos/saved");
    expect(screen.getByRole("link", { name: "查看全部个人记录" })).toHaveAttribute("href", "/");
    expect(useInfiniteMemos.mock.lastCall?.[0].filter).toBe(applied);
    expect(screen.getByTestId("moteary-empty")).toBeInTheDocument();
  });
  it.each([
    "明天再想",
    "[a+b].*",
    '<img src=x onerror="alert(1)">',
  ])("shows a literal, safely rendered annotation match for %s only after search submission", (keyword) => {
    query.data.pages[0].memos = [
      create(MemoSchema, {
        name: "memos/annotation",
        content: `# 会议录音\n\n${"前文".repeat(50)}\n## 我的批注\n讨论前 ${keyword} 讨论后\n${"后文".repeat(50)}`,
        tags: ["拾微", "source/podcast"],
      }),
    ];
    mount();
    fireEvent.change(screen.getByLabelText("资料关键词"), { target: { value: keyword } });
    expect(screen.queryByLabelText("正文命中上下文")).not.toBeInTheDocument();
    fireEvent.submit(screen.getByRole("form", { name: "搜索我的资料" }));
    const snippet = screen.getByLabelText("正文命中上下文");
    expect(snippet).toHaveTextContent("我的批注");
    expect(snippet).toHaveTextContent(`讨论前 ${keyword} 讨论后`);
    expect(snippet.querySelector("mark")).toHaveTextContent(keyword);
    expect(snippet.querySelector("img")).toBeNull();
    expect(snippet.textContent).not.toContain("前文".repeat(50));
    expect(snippet.closest("a")).toHaveAttribute("href", "/memos/annotation");
    fireEvent.click(screen.getByRole("button", { name: "清除搜索" }));
    expect(screen.queryByLabelText("正文命中上下文")).not.toBeInTheDocument();
  });
  it("shows only the actual loaded count, offers pagination, and does not double-fetch", () => {
    query.hasNextPage = true;
    const { rerender } = mount();
    expect(screen.getByText(/当前已加载 0 条，还有更多/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加载更多片段" }));
    expect(query.fetchNextPage).toHaveBeenCalledOnce();
    query.isFetching = true;
    rerender(
      <MemoryRouter>
        <MotearyWorkspace userName="users/alice" />
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "加载更多片段" })).toBeDisabled();
  });
  it("does not interpret failed Space loading as no Spaces", () => {
    spaces.isSpacesError = true;
    mount();
    expect(screen.getByLabelText("来源空间")).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("空间列表未能读取");
  });
});

it("searches only after submit and clears without storing query in URL", () => {
  useInfiniteMemos.mockReturnValue(query);
  mount();
  fireEvent.change(screen.getByLabelText("资料关键词"), { target: { value: "private keyword" } });
  expect(useInfiniteMemos.mock.lastCall?.[0].filter).not.toContain("private keyword");
  fireEvent.submit(screen.getByRole("form", { name: "搜索我的资料" }));
  expect(useInfiniteMemos.mock.lastCall?.[0].filter).toContain('content.contains("private keyword")');
  expect(screen.getByText("当前范围未找到匹配资料")).toBeInTheDocument();
  expect(window.location.search).not.toContain("private");
  fireEvent.click(screen.getByRole("button", { name: "清除搜索" }));
  expect(useInfiniteMemos.mock.lastCall?.[0].filter).not.toContain("content.contains");
  expect(screen.getByLabelText("资料关键词")).toHaveValue("");
  cleanup();
});

it("shows original filenames and honest PDF/audio retrieval boundaries", () => {
  useInfiniteMemos.mockReturnValue(query);
  query.isPending = false;
  query.isFetching = false;
  query.hasNextPage = false;
  query.isError = false;
  query.data.pages[0].memos = [
    create(MemoSchema, {
      name: "memos/asset",
      content: "# 拾微原始资料 · lecture.pdf",
      tags: ["拾微", "source/file"],
      visibility: Visibility.PRIVATE,
      attachments: [{ name: "attachments/pdf", filename: "lecture.pdf.original.zip" }],
    }),
  ];
  mount();
  expect(screen.getByLabelText("附件与检索范围")).toHaveTextContent("不能搜索未解析附件内部内容");
  expect(screen.getByText(/lecture.pdf.original.zip/)).toBeInTheDocument();
  expect(screen.getByTestId("moteary-source-record")).toHaveAttribute("href", "/memos/asset");
  expect(screen.getByText("打开记录查看附件并取回原件")).toBeInTheDocument();
  cleanup();
});

it("keeps audio recovery controls outside the record navigation link", () => {
  useInfiniteMemos.mockReturnValue(query);
  query.isPending = false;
  query.isError = false;
  query.data.pages[0].memos = [
    create(MemoSchema, {
      name: "memos/audio",
      content: `原件 SHA-256：\`${"a".repeat(64)}\``,
      tags: ["拾微", "source/file"],
      attachments: [{ name: "attachments/audio", filename: "synthetic.wav.original.zip" }],
    }),
  ];
  mount();
  const button = screen.getByRole("button", { name: "校验并试听原件" });
  expect(button.closest("a")).toBeNull();
  expect(screen.getByTestId("moteary-source-record")).toHaveAttribute("href", "/memos/audio");
  cleanup();
});

it("applies source/date drafts only on search, preserves the last valid query on error, and resets without losing account scope", () => {
  spaces.isSpacesError = false;
  useInfiniteMemos.mockReturnValue(query);
  query.isPending = false;
  query.isError = false;
  query.data.pages[0].memos = [];
  mount();
  const original = useInfiniteMemos.mock.lastCall?.[0].filter;
  fireEvent.change(screen.getByLabelText("找回来源类型"), { target: { value: "podcast" } });
  fireEvent.change(screen.getByLabelText("保存起始日期"), { target: { value: "2026-11-01" } });
  fireEvent.change(screen.getByLabelText("保存结束日期"), { target: { value: "2026-11-18" } });
  expect(useInfiniteMemos.mock.lastCall?.[0].filter).toBe(original);
  fireEvent.submit(screen.getByRole("form", { name: "搜索我的资料" }));
  const applied = useInfiniteMemos.mock.lastCall?.[0].filter;
  expect(applied).toContain('tag in ["source/podcast"]');
  expect(applied).toContain("created_ts < timestamp(");
  expect(screen.getByLabelText("已应用找回条件")).toHaveTextContent("播客片段 · 2026-11-01 至 2026-11-18");
  expect(screen.getByText("当前范围未找到匹配资料")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("保存起始日期"), { target: { value: "2026-11-20" } });
  fireEvent.submit(screen.getByRole("form", { name: "搜索我的资料" }));
  expect(screen.getByRole("alert")).toHaveTextContent("起始日期不能晚于结束日期");
  expect(useInfiniteMemos.mock.lastCall?.[0].filter).toBe(applied);
  fireEvent.click(screen.getByRole("button", { name: "重置找回条件" }));
  expect(useInfiniteMemos.mock.lastCall?.[0].filter).toBe(original);
  expect(screen.getByLabelText("找回来源类型")).toHaveValue("all");
  expect(screen.getByLabelText("保存起始日期")).toHaveValue("");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(window.location.search).not.toContain("2026");
  cleanup();
});

import { create } from "@bufbuild/protobuf";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoEditorDraftProps } from "@/components/MemoEditor/MemoEditor";
import MotearyWorkspace from "@/components/MotearyWorkspace/MotearyWorkspace";
import { MemoSchema } from "@/types/proto/api/memo_service_pb";

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
  it("queries only the current creator, with supported sort and real pagination", () => {
    mount();
    expect(useInfiniteMemos).toHaveBeenCalledWith(
      expect.objectContaining({ filter: '(creator == "users/alice") && (tag in ["拾微"])', orderBy: "create_time desc", pageSize: 24 }),
    );
    expect(screen.getByTestId("moteary-empty")).toBeInTheDocument();
    expect(screen.getByText(/本设备离线可用性未验证/)).toBeInTheDocument();
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
        content: expect.stringContaining("#拾微 #reference #source/link"),
      }),
    );
    expect(screen.getByTestId("moteary-capture-link")).toBeDisabled();
    expect(screen.getByTestId("moteary-capture-text")).toBeDisabled();
    expect(screen.getByLabelText("新片段分类")).toBeDisabled();
    expect(screen.getByLabelText("来源空间")).toBeDisabled();
    expect(screen.getAllByTestId("original-memo-editor")).toHaveLength(1);
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

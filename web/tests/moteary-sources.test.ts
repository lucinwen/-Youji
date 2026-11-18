import { create } from "@bufbuild/protobuf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { draftKeyFor } from "@/components/MemoEditor/edit/draftKey";
import { initialEditorState } from "@/components/MemoEditor/edit/initialState";
import { cacheService } from "@/components/MemoEditor/edit/services/cacheService";
import {
  buildCaptureStarter,
  buildSourceFilter,
  buildSourceRetrievalFilter,
  getSourceKind,
  getSourceTitle,
  getSourceVisibility,
  SOURCE_KINDS,
} from "@/components/MotearyWorkspace/sources";
import { AttachmentSchema } from "@/types/proto/api/attachment_service_pb";
import { MemoSchema, Visibility } from "@/types/proto/api/memo_service_pb";

describe("Moteary source capture", () => {
  it.each(SOURCE_KINDS)("separates commentary and original material for %s", (kind) => {
    const starter = buildCaptureStarter(kind, "diary");
    expect(starter).toContain(`#拾微 #diary #source/${kind}`);
    expect(starter).toContain("## 我的批注（可不填）");
    expect(starter.indexOf("## 我的批注")).toBeGreaterThan(starter.indexOf("\n\n## "));
  });
  it("limits every list to the signed-in creator and workspace tag", () => {
    expect(buildSourceFilter("users/alice", "all")).toBe('(creator == "users/alice") && (tag in ["拾微"])');
    expect(buildSourceFilter("users/alice", "work", "spaces/one")).toContain('(tag in ["work"]) && (space == "spaces/one")');
    expect(() => buildSourceFilter("", "all")).toThrow();
  });
  it("quotes spaces and user names instead of interpolating CEL operators", () => {
    const filter = buildSourceFilter('users/a" || true', "all", 'spaces/a" || true');
    expect(filter).toContain('creator == "users/a\\" || true"');
    expect(filter).toContain('space == "spaces/a\\" || true"');
  });
  it("does not infer sources without a known editable source tag", () => {
    expect(getSourceKind({ tags: ["拾微", "diary"] })).toBe("unknown");
    expect(getSourceKind({ tags: ["source/link"] })).toBe("link");
    expect(getSourceKind({ tags: ["source/unknown"] })).toBe("unknown");
  });
  it("does not promote headings or template labels to evidence", () => {
    expect(getSourceTitle(buildCaptureStarter("file", "work"))).toBe("一份尚未命名的片段");
    expect(getSourceTitle("#拾微\n\n## 我的原话\n\n我想记住这个时刻。\n\n## 我的批注")).toBe("我想记住这个时刻。");
  });
});

describe("optional editor starter", () => {
  const key = cacheService.key("users/alice", draftKeyFor({ kind: "new", scope: "moteary:text:idea" }));
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((name: string) => storage.get(name) ?? null),
      setItem: vi.fn((name: string, value: string) => storage.set(name, value)),
      removeItem: vi.fn((name: string) => storage.delete(name)),
    });
    cacheService.clearAll();
  });
  afterEach(() => vi.unstubAllGlobals());
  it("seeds only a new draft, preserving original unseeded behavior", () => {
    expect(initialEditorState({ draftKey: key, defaultContent: "starter" }).content).toBe("starter");
    expect(initialEditorState({ draftKey: key }).content).toBe("");
  });
  it("restores user content and visibility instead of replacing it on reopen", () => {
    cacheService.saveNow(key, { content: "my unfinished thought", attachments: [], visibility: Visibility.PRIVATE });
    const restored = initialEditorState({ draftKey: key, defaultContent: "new template", defaultVisibility: Visibility.PUBLIC });
    expect(restored.content).toBe("my unfinished thought");
    expect(restored.metadata.visibility).toBe(Visibility.PRIVATE);
  });
  it("does not silently privatize a restored draft with an explicit audience", () => {
    cacheService.saveNow(key, { content: "explicit public draft", attachments: [], visibility: Visibility.PUBLIC });
    const restored = initialEditorState({ draftKey: key, defaultVisibility: Visibility.PRIVATE });
    expect(restored.metadata.visibility).toBe(Visibility.PUBLIC);
    expect(restored.content).toBe("explicit public draft");
  });
  it("does not replace the intentionally empty content of an attachment-only draft", () => {
    const attachment = create(AttachmentSchema, { name: "attachments/test", filename: "source.txt" });
    cacheService.saveNow(key, { content: "", attachments: [attachment] });
    const restored = initialEditorState({ draftKey: key, defaultContent: "new template" });
    expect(restored.content).toBe("");
    expect(restored.metadata.attachments[0].name).toBe("attachments/test");
  });
  it("does not modify an existing memo or let a seed replace it", () => {
    const memo = create(MemoSchema, { name: "memos/a", content: "server original" });
    cacheService.saveNow(key, { content: "stale", attachments: [] });
    expect(initialEditorState({ draftKey: key, memo, defaultContent: "new template" }).content).toBe("server original");
    expect(cacheService.hasDraft(key)).toBe(false);
  });
  it("keeps user, source, category and Space draft identities separate", () => {
    cacheService.saveNow(key, { content: "private unfinished thought", attachments: [] });
    const alternateKeys = [
      cacheService.key("users/bob", draftKeyFor({ kind: "new", scope: "moteary:text:idea" })),
      cacheService.key("users/alice", draftKeyFor({ kind: "new", scope: "moteary:link:idea" })),
      cacheService.key("users/alice", draftKeyFor({ kind: "new", scope: "moteary:text:work" })),
      cacheService.key("users/alice", draftKeyFor({ kind: "new", scope: "moteary:text:idea", space: "spaces/team" })),
    ];
    for (const draftKey of alternateKeys) expect(initialEditorState({ draftKey, defaultContent: "starter" }).content).toBe("starter");
  });
});

describe("private workspace keyword search", () => {
  it("keeps creator, category and space restrictions while quoting search literally", () => {
    const filter = buildSourceFilter("users/alice", "work", "spaces/team", 'meeting") || true || ("');
    expect(filter).toContain(`content.contains(${JSON.stringify('meeting") || true || ("')})`);
    expect(filter).toContain('space == "spaces/team"');
    expect(filter).toContain('tag in ["work"]');
    expect(filter).toContain("alice");
  });
  it("ignores empty search and bounds long terms", () => {
    expect(buildSourceFilter("users/alice", "all", undefined, "  ")).toBe(buildSourceFilter("users/alice", "all"));
    expect(buildSourceFilter("users/alice", "all", undefined, "x".repeat(201))).toContain(`content.contains("${"x".repeat(200)}")`);
  });
  it("shows the imported filename rather than boilerplate or private note as title", () => {
    expect(getSourceTitle("# 拾微原始资料 · lecture.txt\n\n## 我的批注\nprivate note")).toBe("lecture.txt");
  });
});

describe("source visibility labels", () => {
  it.each([
    [Visibility.PRIVATE, "仅自己可见"],
    [Visibility.PROTECTED, "实例登录用户可见"],
    [Visibility.PUBLIC, "公开范围 · 访客访问取决于实例设置"],
    [Visibility.SPACE, "所属空间成员可见"],
    [Visibility.VISIBILITY_UNSPECIFIED, "可见范围未知 · 请打开记录核对"],
  ])("reports the server visibility %s without assuming privacy", (value, label) => {
    expect(getSourceVisibility(value)).toBe(label);
  });
});

describe("source and local calendar retrieval", () => {
  it("combines source, category, owner, space and literal keyword in one server query", () => {
    const filter = buildSourceFilter("users/alice", "work", "spaces/team", 'quote" || true', {
      kind: "podcast",
      from: "2026-11-01",
      through: "2026-11-18",
    });
    for (const clause of [
      'creator == "users/alice"',
      'tag in ["拾微"]',
      'tag in ["work"]',
      'space == "spaces/team"',
      'tag in ["source/podcast"]',
      `content.contains(${JSON.stringify('quote" || true')})`,
      "created_ts >= timestamp(",
      "created_ts < timestamp(",
    ])
      expect(filter).toContain(clause);
  });
  it("allows one-sided ranges and includes the whole final local day", () => {
    expect(buildSourceRetrievalFilter({ from: "2026-11-18" })).toBe(
      `(created_ts >= timestamp(${new Date(2026, 10, 18).getTime() / 1000}))`,
    );
    expect(buildSourceRetrievalFilter({ through: "2026-11-18" })).toBe(
      `(created_ts < timestamp(${new Date(2026, 10, 19).getTime() / 1000}))`,
    );
    expect(() => buildSourceRetrievalFilter({ from: "2026-11-18", through: "2026-11-18" })).not.toThrow();
    expect(buildSourceRetrievalFilter({ kind: "all" })).toBeUndefined();
  });
  it.each([
    "2026-02-30",
    "2026-13-01",
    "not-a-date",
    '2026-01-01") || true',
  ])("refuses malformed calendar date %s instead of broadening the query", (from) => {
    expect(() => buildSourceRetrievalFilter({ from })).toThrow("有效的保存日期");
  });
  it("refuses reversed ranges and unknown source types", () => {
    expect(() => buildSourceRetrievalFilter({ from: "2026-11-19", through: "2026-11-18" })).toThrow("原筛选保持不变");
    expect(() => buildSourceRetrievalFilter({ kind: "invalid" as "file" })).toThrow("有效的来源类型");
  });
  it("uses local next midnight across daylight saving transitions", () => {
    const filter = buildSourceRetrievalFilter({ from: "2026-03-08", through: "2026-03-08" });
    // This test file is also run explicitly with TZ=America/New_York.
    const eastern = Intl.DateTimeFormat().resolvedOptions().timeZone === "America/New_York";
    const start = Date.parse(eastern ? "2026-03-08T05:00:00Z" : "2026-03-08T00:00:00Z") / 1000;
    const end = Date.parse(eastern ? "2026-03-09T04:00:00Z" : "2026-03-09T00:00:00Z") / 1000;
    if (eastern || Intl.DateTimeFormat().resolvedOptions().timeZone === "UTC") {
      expect(filter).toBe(`(created_ts >= timestamp(${start})) && (created_ts < timestamp(${end}))`);
      expect(end - start).toBe(eastern ? 23 * 3600 : 24 * 3600);
    }
  });
});

describe("PDF retrieval titles", () => {
  it("shows original filename and page instead of code-fence markers", () => {
    expect(getSourceTitle("# 有记 PDF 原件与页码索引\n\n原文件名：\n```\n合成资料.pdf\n```\n")).toBe("合成资料.pdf");
    expect(getSourceTitle("# 有记 PDF 正文 · 第 2 页 / 段 1\n\n原文件名：\n````\n含`符号.pdf\n````\n")).toBe(
      "含`符号.pdf · 第 2 页 / 段 1",
    );
  });
  it("keeps incomplete provenance readable without guessing a filename", () => {
    expect(getSourceTitle("# 有记 PDF 正文 · 第 3 页 / 段 1\n\n原文件名：")).toBe("PDF · 正文 · 第 3 页 / 段 1");
  });
});

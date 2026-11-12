import { create } from "@bufbuild/protobuf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { draftKeyFor } from "@/components/MemoEditor/edit/draftKey";
import { initialEditorState } from "@/components/MemoEditor/edit/initialState";
import { cacheService } from "@/components/MemoEditor/edit/services/cacheService";
import { buildCaptureStarter, buildSourceFilter, getSourceKind, getSourceTitle, SOURCE_KINDS } from "@/components/MotearyWorkspace/sources";
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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteManualDraft,
  type ManualDraftInput,
  readManualDraft,
  readManualDraftRaw,
  writeManualDraft,
} from "@/components/MotearyWorkspace/manualDraftStore";

vi.mock("@/components/MotearyWorkspace/audioImport", () => ({ saveAudio: vi.fn() }));
const owner = "users/synthetic";
const other = "users/other";
const input: ManualDraftInput = { text: "合成草稿\r\n😀\t  原文空格  ", title: "合成标题", source: "diary" };
const key = (account = owner, origin = window.location.origin) =>
  `youji:manual-draft:v1:${encodeURIComponent(origin)}:${encodeURIComponent(account)}`;
let storage: Storage;
const fetchMock = vi.fn();

beforeEach(() => {
  storage = window.localStorage;
  storage.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  expect(fetchMock).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  storage.clear();
});

describe("explicit owner-scoped local manual drafts", () => {
  it("reads an absent draft without creating or deleting any entry", () => {
    const set = vi.spyOn(Storage.prototype, "setItem");
    const remove = vi.spyOn(Storage.prototype, "removeItem");
    expect(readManualDraft(owner)).toBeNull();
    expect(readManualDraftRaw(owner)).toBeNull();
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(storage.length).toBe(0);
  });

  it("stores exact plaintext with owner, origin, version and timestamp under the derived key", () => {
    vi.spyOn(Date, "now").mockReturnValue(1795000000000);
    const saved = writeManualDraft(owner, input, null);
    expect(storage.length).toBe(1);
    expect(storage.getItem(key())).toBe(saved.raw);
    expect(saved.value).toEqual({ ...input, version: 1, owner, origin: window.location.origin, updatedAt: 1795000000000 });
    expect(JSON.parse(saved.raw).text).toBe(input.text);
    expect(readManualDraft(owner)).toEqual(saved);
    expect(readManualDraftRaw(owner)).toBe(saved.raw);
  });

  it("restores the original text after reloading the storage module", async () => {
    const saved = writeManualDraft(owner, input, null);
    vi.resetModules();
    const reloaded = await import("@/components/MotearyWorkspace/manualDraftStore");
    expect(reloaded.readManualDraft(owner)).toEqual(saved);
    expect(reloaded.readManualDraftRaw(owner)).toBe(saved.raw);
  });

  it("does not read, overwrite or delete another owner's entry", () => {
    const first = writeManualDraft(owner, input, null);
    expect(readManualDraft(other)).toBeNull();
    expect(readManualDraftRaw(other)).toBeNull();
    expect(() => writeManualDraft(other, input, first.raw)).toThrow("另一页面");
    const second = writeManualDraft(other, { ...input, text: "其他账户" }, null);
    deleteManualDraft(other, second.raw);
    expect(readManualDraft(other)).toBeNull();
    expect(readManualDraft(owner)).toEqual(first);
  });

  it("derives a distinct key for a distinct origin even when handed the same storage object", () => {
    const first = writeManualDraft(owner, input, null);
    const originalKey = key();
    vi.stubGlobal("window", { location: { origin: "https://other.example.invalid" }, localStorage: storage });
    expect(readManualDraft(owner)).toBeNull();
    const second = writeManualDraft(owner, { ...input, text: "其他站点" }, null);
    expect(storage.getItem(originalKey)).toBe(first.raw);
    expect(storage.getItem(key())).toBe(second.raw);
    expect(storage.length).toBe(2);
  });

  it.each([
    ["owner", other],
    ["origin", "https://other.example.invalid"],
    ["version", 2],
    ["updatedAt", -1],
    ["updatedAt", 1.5],
    ["updatedAt", "1795000000000"],
  ])("refuses tampered %s metadata without changing stored bytes", (field, value) => {
    const saved = writeManualDraft(owner, input, null);
    const damaged = JSON.stringify({ ...saved.value, [field]: value });
    storage.setItem(key(), damaged);
    const set = vi.spyOn(Storage.prototype, "setItem");
    expect(() => readManualDraft(owner)).toThrow("不匹配");
    expect(readManualDraftRaw(owner)).toBe(damaged);
    expect(storage.getItem(key())).toBe(damaged);
    expect(set).not.toHaveBeenCalled();
  });

  it.each(["broken JSON", "null", "[]", "42", '"string"'])("refuses malformed stored value %s", (raw) => {
    storage.setItem(key(), raw);
    expect(() => readManualDraft(owner)).toThrow();
    expect(readManualDraftRaw(owner)).toBe(raw);
    expect(storage.getItem(key())).toBe(raw);
  });

  it("permits explicit deletion of damaged JSON only with its exact raw snapshot", () => {
    storage.setItem(key(), "broken JSON");
    const raw = readManualDraftRaw(owner);
    expect(() => readManualDraft(owner)).toThrow("损坏");
    expect(() => deleteManualDraft(owner, null)).toThrow("未删除");
    deleteManualDraft(owner, raw);
    expect(storage.getItem(key())).toBeNull();
    expect(readManualDraft(owner)).toBeNull();
  });

  it("rejects oversized stored data without deleting it", () => {
    const raw = "x".repeat(800 * 1024 + 1);
    storage.setItem(key(), raw);
    expect(() => readManualDraft(owner)).toThrow("异常过大");
    expect(storage.getItem(key())).toBe(raw);
  });

  it("uses UTF-8 byte limits: accepts 128 KiB exactly and rejects one extra byte", () => {
    const text = `${"中".repeat(43690)}ab`;
    expect(new TextEncoder().encode(text).length).toBe(128 * 1024);
    const saved = writeManualDraft(owner, { ...input, text }, null);
    expect(readManualDraft(owner)?.value.text).toBe(text);
    expect(() => writeManualDraft(owner, { ...input, text: `${text}c` }, saved.raw)).toThrow("128 KiB");
    expect(storage.getItem(key())).toBe(saved.raw);
  });

  it.each([
    { text: 1 },
    { title: null },
    { title: "x".repeat(201) },
    { source: "__proto__" },
    { source: "toString" },
  ])("rejects invalid input and invalid stored content %j", (change) => {
    const invalid = { ...input, ...change } as ManualDraftInput;
    expect(() => writeManualDraft(owner, invalid, null)).toThrow("格式或大小");
    expect(storage.length).toBe(0);
    const saved = writeManualDraft(owner, input, null);
    storage.setItem(key(), JSON.stringify({ ...saved.value, ...change }));
    expect(() => readManualDraft(owner)).toThrow("格式或大小");
  });

  it("rejects invalid owner and non-HTTP origins before touching storage", () => {
    const get = vi.spyOn(Storage.prototype, "getItem");
    for (const account of ["", "users/../other", "users/a/b"]) {
      expect(() => readManualDraft(account)).toThrow("登录");
      expect(() => readManualDraftRaw(account)).toThrow("登录");
      expect(() => writeManualDraft(account, input, null)).toThrow("登录");
      expect(() => deleteManualDraft(account, null)).toThrow("登录");
    }
    vi.stubGlobal("window", { location: { origin: "null" }, localStorage: storage });
    expect(() => readManualDraft(owner)).toThrow("当前站点");
    expect(get).not.toHaveBeenCalled();
  });

  it("refuses stale writes and deletes while preserving the newer draft", () => {
    const first = writeManualDraft(owner, input, null);
    const second = writeManualDraft(owner, { ...input, text: "另一页面的新内容" }, first.raw);
    expect(() => writeManualDraft(owner, { ...input, text: "旧页面内容" }, first.raw)).toThrow("另一页面");
    expect(() => writeManualDraft(owner, input, null)).toThrow("另一页面");
    expect(() => deleteManualDraft(owner, first.raw)).toThrow("未删除");
    expect(() => deleteManualDraft(owner, null)).toThrow("未删除");
    expect(readManualDraft(owner)).toEqual(second);
    deleteManualDraft(owner, second.raw);
    expect(readManualDraft(owner)).toBeNull();
    expect(readManualDraftRaw(owner)).toBeNull();
    expect(storage.length).toBe(0);
    expect(() => writeManualDraft(owner, input, second.raw)).toThrow("另一页面");
    expect(storage.length).toBe(0);
  });

  it("returns an actionable error when access to localStorage itself is forbidden", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("private browser details", "SecurityError");
    });
    for (const operation of [
      () => readManualDraft(owner),
      () => readManualDraftRaw(owner),
      () => writeManualDraft(owner, input, null),
      () => deleteManualDraft(owner, null),
    ]) {
      expect(operation).toThrow("无法访问本地草稿存储");
      expect(operation).not.toThrow("private browser details");
    }
  });

  it("preserves existing bytes when a quota error prevents saving", () => {
    const saved = writeManualDraft(owner, input, null);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("synthetic quota", "QuotaExceededError");
    });
    expect(() => writeManualDraft(owner, { ...input, text: "新输入仍在页面" }, saved.raw)).toThrow("空间不足");
    expect(readManualDraft(owner)).toEqual(saved);
    expect(input.text).toContain("合成草稿");
  });

  it("does not report deletion success when removeItem is denied", () => {
    const saved = writeManualDraft(owner, input, null);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("synthetic denial", "SecurityError");
    });
    expect(() => deleteManualDraft(owner, saved.raw)).toThrow("无法访问");
    expect(readManualDraft(owner)).toEqual(saved);
  });
});

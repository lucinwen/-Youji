import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteManualDraft,
  type ManualDraftInput,
  readLegacyManualDraft,
  readManualDraft,
  readManualDraftRaw,
  writeManualDraft,
} from "@/components/MotearyWorkspace/manualDraftStore";
import { installManualDraftLocks } from "./helpers/manual-draft-locks";

vi.mock("@/components/MotearyWorkspace/audioImport", () => ({ saveAudio: vi.fn() }));
const owner = "users/synthetic";
const other = "users/other";
const input: ManualDraftInput = { text: "合成草稿\r\n😀\t  原文空格  ", title: "合成标题", source: "diary" };
const key = (account = owner, origin = window.location.origin) =>
  `youji:manual-draft:v2:${encodeURIComponent(origin)}:${encodeURIComponent(account)}`;
let storage: Storage;
let locks: ReturnType<typeof installManualDraftLocks>;
const fetchMock = vi.fn();

beforeEach(() => {
  locks = installManualDraftLocks();
  storage = window.localStorage;
  storage.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  expect(fetchMock).not.toHaveBeenCalled();
  locks.restore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  storage.clear();
});

describe("explicit owner-scoped local manual drafts", () => {
  it("reads an absent draft without creating or deleting any entry", async () => {
    const set = vi.spyOn(Storage.prototype, "setItem");
    const remove = vi.spyOn(Storage.prototype, "removeItem");
    expect(readManualDraft(owner)).toBeNull();
    expect(readManualDraftRaw(owner)).toBeNull();
    expect(set).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(storage.length).toBe(0);
  });

  it("stores exact plaintext with owner, origin, version and timestamp under the derived key", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1795000000000);
    const saved = await writeManualDraft(owner, input, null);
    expect(storage.length).toBe(1);
    expect(storage.getItem(key())).toBe(saved.raw);
    expect(saved.value).toEqual({
      ...input,
      version: 2,
      revision: expect.any(String),
      owner,
      origin: window.location.origin,
      updatedAt: 1795000000000,
    });
    expect(JSON.parse(saved.raw).text).toBe(input.text);
    expect(readManualDraft(owner)).toEqual(saved);
    expect(readManualDraftRaw(owner)).toBe(saved.raw);
  });

  it("restores the original text after reloading the storage module", async () => {
    const saved = await writeManualDraft(owner, input, null);
    vi.resetModules();
    const reloaded = await import("@/components/MotearyWorkspace/manualDraftStore");
    expect(reloaded.readManualDraft(owner)).toEqual(saved);
    expect(reloaded.readManualDraftRaw(owner)).toBe(saved.raw);
  });

  it("does not read, overwrite or delete another owner's entry", async () => {
    const first = await writeManualDraft(owner, input, null);
    expect(readManualDraft(other)).toBeNull();
    expect(readManualDraftRaw(other)).toBeNull();
    await expect(writeManualDraft(other, input, first.raw)).rejects.toThrow("另一页面");
    const second = await writeManualDraft(other, { ...input, text: "其他账户" }, null);
    await deleteManualDraft(other, second.raw);
    expect(readManualDraft(other)).toBeNull();
    expect(readManualDraft(owner)).toEqual(first);
  });

  it("derives a distinct key for a distinct origin even when handed the same storage object", async () => {
    const first = await writeManualDraft(owner, input, null);
    const originalKey = key();
    vi.stubGlobal("window", { location: { origin: "https://other.example.invalid" }, localStorage: storage });
    expect(readManualDraft(owner)).toBeNull();
    const second = await writeManualDraft(owner, { ...input, text: "其他站点" }, null);
    expect(storage.getItem(originalKey)).toBe(first.raw);
    expect(storage.getItem(key())).toBe(second.raw);
    expect(storage.length).toBe(2);
  });

  it.each([
    ["owner", other],
    ["origin", "https://other.example.invalid"],
    ["version", 1],
    ["updatedAt", -1],
    ["updatedAt", 1.5],
    ["updatedAt", "1795000000000"],
  ])("refuses tampered %s metadata without changing stored bytes", async (field, value) => {
    const saved = await writeManualDraft(owner, input, null);
    const damaged = JSON.stringify({ ...saved.value, [field]: value });
    storage.setItem(key(), damaged);
    const set = vi.spyOn(Storage.prototype, "setItem");
    expect(() => readManualDraft(owner)).toThrow("不匹配");
    expect(readManualDraftRaw(owner)).toBe(damaged);
    expect(storage.getItem(key())).toBe(damaged);
    expect(set).not.toHaveBeenCalled();
  });

  it.each(["broken JSON", "null", "[]", "42", '"string"'])("refuses malformed stored value %s", async (raw) => {
    storage.setItem(key(), raw);
    expect(() => readManualDraft(owner)).toThrow();
    expect(readManualDraftRaw(owner)).toBe(raw);
    expect(storage.getItem(key())).toBe(raw);
  });

  it("permits explicit deletion of damaged JSON only with its exact raw snapshot", async () => {
    storage.setItem(key(), "broken JSON");
    const raw = readManualDraftRaw(owner);
    expect(() => readManualDraft(owner)).toThrow("损坏");
    await expect(deleteManualDraft(owner, null)).rejects.toThrow("未删除");
    await deleteManualDraft(owner, raw);
    expect(storage.getItem(key())).toBeNull();
    expect(readManualDraft(owner)).toBeNull();
  });

  it("rejects oversized stored data without deleting it", async () => {
    const raw = "x".repeat(800 * 1024 + 1);
    storage.setItem(key(), raw);
    expect(() => readManualDraft(owner)).toThrow("异常过大");
    expect(storage.getItem(key())).toBe(raw);
  });

  it("uses UTF-8 byte limits: accepts 128 KiB exactly and rejects one extra byte", async () => {
    const text = `${"中".repeat(43690)}ab`;
    expect(new TextEncoder().encode(text).length).toBe(128 * 1024);
    const saved = await writeManualDraft(owner, { ...input, text }, null);
    expect(readManualDraft(owner)?.value.text).toBe(text);
    await expect(writeManualDraft(owner, { ...input, text: `${text}c` }, saved.raw)).rejects.toThrow("128 KiB");
    expect(storage.getItem(key())).toBe(saved.raw);
  });

  it.each([
    { text: 1 },
    { title: null },
    { title: "x".repeat(201) },
    { source: "__proto__" },
    { source: "toString" },
  ])("rejects invalid input and invalid stored content %j", async (change) => {
    const invalid = { ...input, ...change } as ManualDraftInput;
    await expect(writeManualDraft(owner, invalid, null)).rejects.toThrow("格式或大小");
    expect(storage.length).toBe(0);
    const saved = await writeManualDraft(owner, input, null);
    storage.setItem(key(), JSON.stringify({ ...saved.value, ...change }));
    expect(() => readManualDraft(owner)).toThrow("格式或大小");
  });

  it("rejects invalid owner and non-HTTP origins before touching storage", async () => {
    const get = vi.spyOn(Storage.prototype, "getItem");
    for (const account of ["", "users/../other", "users/a/b"]) {
      expect(() => readManualDraft(account)).toThrow("登录");
      expect(() => readManualDraftRaw(account)).toThrow("登录");
      await expect(writeManualDraft(account, input, null)).rejects.toThrow("登录");
      await expect(deleteManualDraft(account, null)).rejects.toThrow("登录");
    }
    vi.stubGlobal("window", { location: { origin: "null" }, localStorage: storage });
    expect(() => readManualDraft(owner)).toThrow("当前站点");
    expect(get).not.toHaveBeenCalled();
  });

  it("refuses stale writes and deletes while preserving the newer draft", async () => {
    const first = await writeManualDraft(owner, input, null);
    const second = await writeManualDraft(owner, { ...input, text: "另一页面的新内容" }, first.raw);
    await expect(writeManualDraft(owner, { ...input, text: "旧页面内容" }, first.raw)).rejects.toThrow("另一页面");
    await expect(writeManualDraft(owner, input, null)).rejects.toThrow("另一页面");
    await expect(deleteManualDraft(owner, first.raw)).rejects.toThrow("未删除");
    await expect(deleteManualDraft(owner, null)).rejects.toThrow("未删除");
    expect(readManualDraft(owner)).toEqual(second);
    await deleteManualDraft(owner, second.raw);
    expect(readManualDraft(owner)).toBeNull();
    expect(readManualDraftRaw(owner)).toBeNull();
    expect(storage.length).toBe(0);
    await expect(writeManualDraft(owner, input, second.raw)).rejects.toThrow("另一页面");
    expect(storage.length).toBe(0);
  });

  it("returns an actionable error when access to localStorage itself is forbidden", async () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("private browser details", "SecurityError");
    });
    for (const operation of [
      () => readManualDraft(owner),
      () => readManualDraftRaw(owner),
      () => writeManualDraft(owner, input, null),
      () => deleteManualDraft(owner, null),
    ]) {
      await expect(
        Promise.resolve().then(async () => {
          await operation();
        }),
      ).rejects.toThrow("无法访问本地草稿存储");
      await expect(
        Promise.resolve().then(async () => {
          await operation();
        }),
      ).rejects.not.toThrow("private browser details");
    }
  });

  it("preserves existing bytes when a quota error prevents saving", async () => {
    const saved = await writeManualDraft(owner, input, null);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("synthetic quota", "QuotaExceededError");
    });
    await expect(writeManualDraft(owner, { ...input, text: "新输入仍在页面" }, saved.raw)).rejects.toThrow("空间不足");
    expect(readManualDraft(owner)).toEqual(saved);
    expect(input.text).toContain("合成草稿");
  });

  it("does not report deletion success when removeItem is denied", async () => {
    const saved = await writeManualDraft(owner, input, null);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("synthetic denial", "SecurityError");
    });
    await expect(deleteManualDraft(owner, saved.raw)).rejects.toThrow("无法访问");
    expect(readManualDraft(owner)).toEqual(saved);
  });
  it("serializes simultaneous writers and rejects deletion queued behind a newer write", async () => {
    const original = await writeManualDraft(owner, input, null);
    let release!: () => void;
    const held = locks.request(
      key(),
      { mode: "exclusive" },
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    const next = writeManualDraft(owner, { ...input, text: "newer" }, original.raw);
    const staleDelete = expect(deleteManualDraft(owner, original.raw)).rejects.toThrow("未删除");
    expect(readManualDraft(owner)).toEqual(original);
    release();
    await held;
    const saved = await next;
    await staleDelete;
    expect(readManualDraft(owner)).toEqual(saved);
    const results = await Promise.allSettled([writeManualDraft(owner, input, saved.raw), writeManualDraft(owner, input, saved.raw)]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(locks.request.mock.calls.every((call) => call[1].mode === "exclusive")).toBe(true);
  });
  it.each(["write", "delete"])("aborts a queued %s before mutation", async (operation) => {
    const original = await writeManualDraft(owner, input, null);
    let release!: () => void;
    const held = locks.request(
      key(),
      { mode: "exclusive" },
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    const abort = new AbortController();
    const pending =
      operation === "write"
        ? writeManualDraft(owner, { ...input, text: "cancelled" }, original.raw, abort.signal)
        : deleteManualDraft(owner, original.raw, abort.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    abort.abort();
    await rejected;
    release();
    await held;
    await Promise.resolve();
    expect(readManualDraft(owner)).toEqual(original);
  });
  it("fails closed without Web Locks and explains secure contexts", async () => {
    const original = await writeManualDraft(owner, input, null);
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    await expect(writeManualDraft(owner, input, original.raw)).rejects.toThrow("HTTPS 或 localhost");
    await expect(deleteManualDraft(owner, original.raw)).rejects.toThrow("Web Locks");
    expect(readManualDraft(owner)).toEqual(original);
  });
  it("uses unique revisions even for identical content in the same millisecond", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1795000000000);
    const first = await writeManualDraft(owner, input, null);
    const second = await writeManualDraft(owner, input, first.raw);
    expect(first.value.updatedAt).toBe(second.value.updatedAt);
    expect(first.raw).not.toBe(second.raw);
    await expect(deleteManualDraft(owner, first.raw)).rejects.toThrow("未删除");
  });
  it("keeps legacy keys read-only and independent from new writes and removal", async () => {
    const legacyKey = key().replace(":v2:", ":v1:");
    const raw = JSON.stringify({ ...input, version: 1, owner, origin: window.location.origin, updatedAt: 1795000000000 });
    storage.setItem(legacyKey, raw);
    expect(readManualDraft(owner)).toBeNull();
    expect(readLegacyManualDraft(owner)?.raw).toBe(raw);
    const current = await writeManualDraft(owner, input, null);
    const newerLegacy = JSON.stringify({ ...JSON.parse(raw), text: "old tab update" });
    storage.setItem(legacyKey, newerLegacy);
    await deleteManualDraft(owner, current.raw);
    expect(storage.getItem(legacyKey)).toBe(newerLegacy);
    expect(readManualDraft(owner)).toBeNull();
  });
});

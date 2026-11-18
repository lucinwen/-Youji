// @vitest-environment node
// Real Node Web Locks + synthetic synchronous storage; not browser/tab validation.
// Node 24.22.1 retains locks after synchronously throwing callbacks; the store's
// async callback must also release them after conflicts (tested below).
import * as workerThreads from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteManualDraft, readManualDraft, writeManualDraft } from "@/components/MotearyWorkspace/manualDraftStore";

// Avoid loading unrelated authentication/HTTP clients. The draft store and SOURCES are real.
vi.mock("@/auth-state", () => ({ getAccessToken: vi.fn() }));
vi.mock("@/connect", () => ({ authServiceClient: {} }));

let owner: string;
const origin = "https://synthetic.example.invalid";
let key: string;
const input = { text: "合成原文", title: "Synthetic", source: "diary" as const };
const locks = workerThreads.locks;
let values: Map<string, string>;

beforeEach(() => {
  // Fail explicitly on unsupported runtimes instead of silently replacing locks.
  expect(navigator.locks).toBe(locks);
  expect(typeof locks.request).toBe("function");
  owner = `users/synthetic-${crypto.randomUUID()}`;
  key = `youji:manual-draft:v2:${encodeURIComponent(origin)}:${encodeURIComponent(owner)}`;
  values = new Map();
  vi.stubGlobal("window", {
    location: { origin },
    localStorage: {
      getItem: (name: string) => values.get(name) ?? null,
      setItem: (name: string, value: string) => values.set(name, value),
      removeItem: (name: string) => values.delete(name),
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Network is forbidden in this synthetic test");
    }),
  );
});

afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

async function holdLock() {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const done = locks.request(key, { mode: "exclusive" }, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  return { release: release.resolve, done };
}

describe.skipIf(process.env.YOUJI_NATIVE_DRAFT_LOCK_QA !== "1")("actual draft store with Node native Web Locks (synthetic storage)", () => {
  it("serializes concurrent writes sharing the same expected snapshot into one winner and one conflict", async () => {
    const held = await holdLock();
    const results = Promise.allSettled([
      writeManualDraft(owner, { ...input, text: "candidate A" }, null),
      writeManualDraft(owner, { ...input, text: "candidate B" }, null),
    ]);
    try {
      expect((await locks.query()).pending?.filter((lock) => lock.name === key)).toHaveLength(2);
    } finally {
      held.release();
      await held.done;
    }
    const settled = await results;
    const winners = settled.filter((result) => result.status === "fulfilled");
    const conflicts = settled.filter((result) => result.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(String(conflicts[0].reason)).toContain("另一页面");
    expect(readManualDraft(owner)).toEqual(winners[0].value);
    expect(values.size).toBe(1);
    const subsequent = await writeManualDraft(owner, { ...input, text: "after conflict" }, winners[0].value.raw);
    await deleteManualDraft(owner, subsequent.raw);
    expect(readManualDraft(owner)).toBeNull();
  });

  it("checks a queued stale delete only after the earlier queued write, preserving the newer bytes", async () => {
    const initial = await writeManualDraft(owner, input, null);
    const held = await holdLock();
    const write = writeManualDraft(owner, { ...input, text: "newer synthetic text" }, initial.raw);
    const remove = deleteManualDraft(owner, initial.raw);
    const rejected = expect(remove).rejects.toThrow("未删除");
    try {
      expect((await locks.query()).pending?.filter((lock) => lock.name === key)).toHaveLength(2);
    } finally {
      held.release();
      await held.done;
    }
    const newer = await write;
    await rejected;
    expect(readManualDraft(owner)).toEqual(newer);
    expect(values.get(key)).toBe(newer.raw);
    const subsequent = await writeManualDraft(owner, { ...input, text: "after stale delete" }, newer.raw);
    await deleteManualDraft(owner, subsequent.raw);
    expect(readManualDraft(owner)).toBeNull();
  });

  it.each(["write", "delete"] as const)("aborts a queued %s without mutating storage", async (operation) => {
    const initial = await writeManualDraft(owner, input, null);
    const held = await holdLock();
    const controller = new AbortController();
    const pending =
      operation === "write"
        ? writeManualDraft(owner, { ...input, text: "cancelled synthetic text" }, initial.raw, controller.signal)
        : deleteManualDraft(owner, initial.raw, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    try {
      expect((await locks.query()).pending?.filter((lock) => lock.name === key)).toHaveLength(1);
      controller.abort();
      await rejected;
      // Node can retain a cancelled entry in query() until the holder releases;
      // assert observable cancellation/no mutation rather than eager queue cleanup.
      expect(readManualDraft(owner)).toEqual(initial);
    } finally {
      controller.abort();
      held.release();
      await held.done;
    }
    // A subsequent actual native lock acquisition also proves the queue still progresses.
    await locks.request(key, () => expect(values.get(key)).toBe(initial.raw));
    expect((await locks.query()).pending?.filter((lock) => lock.name === key)).toHaveLength(0);
  });
});

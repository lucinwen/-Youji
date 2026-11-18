import { File as NodeFile } from "node:buffer";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { Code, ConnectError } from "@connectrpc/connect";
import { unzipSync } from "fflate";
import { expect, it, vi } from "vitest";
import { deleteManualDraft, readManualDraft, writeManualDraft } from "@/components/MotearyWorkspace/manualDraftStore";
import { prepareManualText, preparePastedText, saveManualText } from "@/components/MotearyWorkspace/manualTextImport";
import { Visibility } from "@/types/proto/api/memo_service_pb";
import { installManualDraftLocks } from "./helpers/manual-draft-locks";

// Transport adapters invoke the real REST gateway. Only specific failure cases
// deliberately drop a successful server response at this client boundary.
const rpc = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getUserUsage: vi.fn(),
  getMemo: vi.fn(),
  createMemo: vi.fn(),
  listAttachments: vi.fn(),
  createAttachment: vi.fn(),
  getAttachment: vi.fn(),
}));
vi.mock("@/connect", () => ({
  authServiceClient: { getCurrentUser: rpc.getCurrentUser },
  userServiceClient: { getUserUsage: rpc.getUserUsage },
  memoServiceClient: { getMemo: rpc.getMemo, createMemo: rpc.createMemo },
  attachmentServiceClient: {
    listAttachments: rpc.listAttachments,
    createAttachment: rpc.createAttachment,
    getAttachment: rpc.getAttachment,
  },
}));
vi.mock("@/auth-state", () => ({ getAccessToken: () => null }));
const nativeFetch = globalThis.fetch.bind(globalThis);

it.skipIf(!process.env.YOUJI_MANUAL_TEXT_WEB_QA)(
  "runs actual manual text module over real HTTP with original-byte recovery and isolation",
  async () => {
    const draftLocks = installManualDraftLocks();
    const config = JSON.parse(process.env.YOUJI_MANUAL_TEXT_WEB_QA ?? "{}");
    const requests: { method: string; path: string }[] = [];
    let nextRequestAt = 0;
    const realFetch = async (url: string, options: RequestInit = {}) => {
      // Respect the real server's request budget rather than changing its limits.
      const slot = Math.max(Date.now(), nextRequestAt);
      nextRequestAt = slot + 600;
      if (slot > Date.now()) await new Promise((resolve) => setTimeout(resolve, slot - Date.now()));
      requests.push({ method: options.method ?? "GET", path: new URL(url).pathname });
      return nativeFetch(url, options);
    };
    const call = async (method: string, path: string, body?: object, token = config.token) => {
      const response = await realFetch(`${config.base}/api/${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok) throw new ConnectError(`HTTP ${response.status}`, response.status === 404 ? Code.NotFound : Code.Internal);
      return response.json();
    };
    const memo = (value: Record<string, unknown>) => ({
      ...value,
      visibility: value.visibility === "PRIVATE" ? Visibility.PRIVATE : Visibility.PUBLIC,
      attachments: value.attachments ?? [],
    });
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("File", NodeFile);
    let loseNextCommittedResponse = false;
    vi.stubGlobal("fetch", async (url: string, options: RequestInit = {}) => {
      const response = await realFetch(`${config.base}${url}`, {
        ...options,
        headers: { ...options.headers, Authorization: `Bearer ${config.token}` },
      });
      if (url === "/api/youji/manual-text/import" && response.ok && loseNextCommittedResponse) {
        loseNextCommittedResponse = false;
        await response.arrayBuffer();
        throw new Error("synthetic committed transaction response loss");
      }
      return response;
    });
    rpc.getCurrentUser.mockImplementation(() => call("GET", "auth/me"));
    rpc.getUserUsage.mockImplementation(async ({ name }) => {
      const value = await call("GET", name);
      value.limits.memoContentBytes = BigInt(value.limits.memoContentBytes ?? 0);
      return value;
    });
    rpc.getMemo.mockImplementation(async ({ name }) => memo(await call("GET", name)));
    const createMemo = async ({ memoId, memo: value }: { memoId: string; memo: object }) =>
      memo(await call("POST", `memos?memoId=${memoId}`, { ...value, visibility: "PRIVATE" }));
    const upload = ({ attachment }: { attachment: { content: Uint8Array } }) =>
      call("POST", "attachments", { ...attachment, content: Buffer.from(attachment.content).toString("base64") });
    rpc.createMemo.mockImplementation(createMemo);
    rpc.createAttachment.mockImplementation(upload);
    rpc.getAttachment.mockImplementation(({ name }) => call("GET", name));
    rpc.listAttachments.mockImplementation(async (args) => {
      const value = await call("GET", `attachments?${new URLSearchParams(args)}`);
      return { attachments: value.attachments ?? [], nextPageToken: value.nextPageToken ?? "" };
    });
    const data = new Uint8Array(readFileSync(config.fixture));
    const file = (name: string, bytes: Uint8Array) =>
      ({ name, size: bytes.length, arrayBuffer: async () => new Uint8Array(bytes).buffer }) as File;
    const original = file("合成微信聊天.txt", data);
    const options = { source: "wechat" as const, title: "合成聊天" };
    const signal = () => new AbortController().signal;
    const list = async (kind: "memos" | "attachments") => (await call("GET", kind))[kind] ?? [];
    const archiveURL = (attachment: { name: string; filename: string }) =>
      `${config.base}/file/${attachment.name}/${encodeURIComponent(attachment.filename)}`;
    try {
      const beforePrepare = requests.length;
      const plan = await prepareManualText(original, config.owner, options);
      expect(plan.text).toBe(new TextDecoder().decode(data));
      expect(plan.title).toBe("合成聊天");
      expect(plan.item.content).toContain("#source/conversation");
      expect(plan.item.content).toContain("<script>literalOnly()</script>");
      expect(plan.item.data).toEqual(data);
      expect(requests).toHaveLength(beforePrepare);
      const markdown = await prepareManualText(
        file("synthetic.md", new TextEncoder().encode("# 原文标题\n**不执行格式**")),
        config.owner,
        options,
      );
      expect(markdown.text).toContain("**不执行格式**");
      await expect(prepareManualText(file("invalid.txt", new Uint8Array([0xff])), config.owner, options)).rejects.toThrow();
      await expect(prepareManualText(file("oversize.txt", new Uint8Array(128 * 1024 + 1)), config.owner, options)).rejects.toThrow();
      expect(requests).toHaveLength(beforePrepare);
      expect(await list("memos")).toHaveLength(0);
      const receipt = await saveManualText(plan, signal(), vi.fn());
      expect(receipt.status).toBe("imported");
      expect((await saveManualText(plan, signal(), vi.fn())).status).toBe("verified");
      expect(await list("memos")).toHaveLength(1);
      expect(await list("attachments")).toHaveLength(1);
      const saved = await call("GET", receipt.memo);
      expect(saved.visibility).toBe("PRIVATE");
      expect(saved.content).toBe(plan.item.content);
      const attachment = saved.attachments[0];
      const originalURL = archiveURL(attachment);
      const downloaded = await realFetch(originalURL, { headers: { Authorization: `Bearer ${config.token}` } });
      expect(downloaded.status).toBe(200);
      expect(downloaded.headers.get("content-disposition")).toContain("attachment");
      expect(downloaded.headers.get("x-content-type-options")).toBe("nosniff");
      const archived = unzipSync(new Uint8Array(await downloaded.arrayBuffer()));
      expect(Object.keys(archived)).toEqual([original.name]);
      expect(archived[original.name]).toEqual(data);

      const search = `memos?${new URLSearchParams({ filter: 'tag in ["source/conversation"] && content.contains("ManualTextNeedle")' })}`;
      expect((await call("GET", search)).memos).toHaveLength(1);
      const embeddedTagSearch = `memos?${new URLSearchParams({ filter: 'tag in ["source/not-a-real-tag"]' })}`;
      expect((await call("GET", embeddedTagSearch)).memos ?? []).toHaveLength(0);
      expect((await call("GET", search, undefined, config.otherToken)).memos ?? []).toHaveLength(0);
      for (const token of [null, config.otherToken]) {
        const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
        for (const url of [`${config.base}/api/${receipt.memo}`, originalURL])
          expect([401, 403, 404]).toContain((await realFetch(url, { headers })).status);
      }
      for (const name of [receipt.memo, attachment.name])
        expect([401, 403, 404]).toContain(
          (await realFetch(`${config.base}/api/${name}`, { method: "DELETE", headers: { Authorization: `Bearer ${config.otherToken}` } }))
            .status,
        );

      // Paste also uses a real private record and a byte-preserving original.
      const pastedText = "PastedManualNeedle 合成粘贴原文\n```\n#source/not-a-real-tag\n```";
      // jsdom localStorage persists through a simulated editor lifecycle; this is not a browser refresh test.
      const local = await writeManualDraft(config.owner, { text: pastedText, ...options }, null);
      expect(readManualDraft("users/synthetic-other-local")).toBeNull();
      const restoredDraft = readManualDraft(config.owner);
      expect(restoredDraft?.value.text).toBe(pastedText);
      const pasted = await preparePastedText(restoredDraft!.value.text, config.owner, restoredDraft!.value);
      expect(pasted.text).toBe(pastedText);
      const pastedReceipt = await saveManualText(pasted, signal(), vi.fn());
      // A page lost after the actual server commit can restore the same text and verify, not create twice.
      const retryDraft = readManualDraft(config.owner)!;
      const retriedPlan = await preparePastedText(retryDraft.value.text, config.owner, retryDraft.value);
      expect((await saveManualText(retriedPlan, signal(), vi.fn())).status).toBe("verified");
      await deleteManualDraft(config.owner, local.raw);
      expect(readManualDraft(config.owner)).toBeNull();
      const pastedSaved = await call("GET", pastedReceipt.memo);
      expect(pastedSaved.visibility).toBe("PRIVATE");
      const pastedDownload = await realFetch(archiveURL(pastedSaved.attachments[0]), {
        headers: { Authorization: `Bearer ${config.token}` },
      });
      const pastedArchive = unzipSync(new Uint8Array(await pastedDownload.arrayBuffer()));
      expect(Array.from(pastedArchive[pasted.item.filename])).toEqual(Array.from(new TextEncoder().encode(pastedText)));
      await call("DELETE", pastedReceipt.memo);

      const edited = `${saved.content}\n人工后续修改，保留此更正。`;
      await call("PATCH", `${receipt.memo}?updateMask=content`, { name: receipt.memo, content: edited });
      await expect(saveManualText(plan, signal(), vi.fn())).rejects.toThrow();
      expect((await call("GET", receipt.memo)).content).toBe(edited);
      expect(await list("memos")).toHaveLength(1);
      expect(await list("attachments")).toHaveLength(1);
      await call("DELETE", receipt.memo);
      expect((await realFetch(originalURL, { headers: { Authorization: `Bearer ${config.token}` } })).status).toBe(404);
      expect((await call("GET", search)).memos ?? []).toHaveLength(0);
      expect(await list("attachments")).toHaveLength(0);

      // Both rows are committed by the real endpoint before a client-side lost response.
      loseNextCommittedResponse = true;
      const memoEvents: string[] = [];
      await expect(saveManualText(plan, signal(), (r) => memoEvents.push(r.status))).rejects.toThrow();
      expect(memoEvents).toContain("save-unknown");
      expect(await list("memos")).toHaveLength(1);
      expect(await list("attachments")).toHaveLength(1);
      expect((await saveManualText(plan, signal(), vi.fn())).status).toBe("verified");
      expect(await list("memos")).toHaveLength(1);
      expect(await list("attachments")).toHaveLength(1);
      expect(requests.some((r) => r.path.includes("/youji/audio/") || r.path.includes("/youji/retrieval/"))).toBe(false);
    } finally {
      draftLocks.restore();
      vi.unstubAllGlobals();
    }
  },
  280_000,
);

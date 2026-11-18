import { webcrypto } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { Worker as NodeWorker } from "node:worker_threads";
import { Code, ConnectError } from "@connectrpc/connect";
import { unzipSync } from "fflate";
import { expect, it, vi } from "vitest";
import { prepareHTML, saveHTML } from "@/components/MotearyWorkspace/htmlImport";
import { Visibility } from "@/types/proto/api/memo_service_pb";

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

it.skipIf(!process.env.YOUJI_HTML_WEB_QA)(
  "runs actual HTML module against real HTTP including recovery, isolation and deletion",
  async () => {
    const config = JSON.parse(process.env.YOUJI_HTML_WEB_QA ?? "{}");
    const call = async (method: string, path: string, body?: object, token = config.token) => {
      const response = await nativeFetch(`${config.base}/api/${path}`, {
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
    vi.stubGlobal("fetch", (url: string, options: RequestInit = {}) =>
      nativeFetch(`${config.base}${url}`, { ...options, headers: { ...options.headers, Authorization: `Bearer ${config.token}` } }),
    );
    rpc.getCurrentUser.mockImplementation(() => call("GET", "auth/me"));
    rpc.getUserUsage.mockImplementation(async ({ name }) => {
      const value = await call("GET", name);
      value.limits.memoContentBytes = BigInt(value.limits.memoContentBytes ?? 0);
      return value;
    });
    rpc.getMemo.mockImplementation(async ({ name }) => memo(await call("GET", name)));
    const createMemo = async ({ memoId, memo: value }: { memoId: string; memo: object }) =>
      memo(await call("POST", `memos?memoId=${memoId}`, { ...value, visibility: "PRIVATE" }));
    rpc.createMemo.mockImplementation(createMemo);
    const upload = ({ attachment }: { attachment: { content: Uint8Array } }) =>
      call("POST", "attachments", { ...attachment, content: Buffer.from(attachment.content).toString("base64") });
    rpc.createAttachment.mockImplementation(upload);
    rpc.getAttachment.mockImplementation(({ name }) => call("GET", name));
    rpc.listAttachments.mockImplementation(async (args) => {
      const result = await call("GET", `attachments?${new URLSearchParams(args)}`);
      return { attachments: result.attachments ?? [], nextPageToken: result.nextPageToken ?? "" };
    });
    // Execute the actual production-bundled worker under Node's worker scheduler.
    // This is not a browser DOM or browser Worker acceptance test.
    const workers: NodeWorker[] = [];
    let requested = 0;
    let onWorkerStart: (() => void) | undefined;
    let cancelledAfterStart = false;
    const sensor = createServer((_req, response) => {
      requested++;
      response.end("unexpected resource request");
    });
    await new Promise<void>((resolve) => sensor.listen(0, "127.0.0.1", resolve));
    const address = sensor.address();
    if (!address || typeof address === "string") throw new Error("sensor did not bind");
    const trap = `http://127.0.0.1:${address.port}/should-not-be-requested`;
    class ActualWorker {
      onmessage?: (event: MessageEvent) => void;
      onerror?: () => void;
      private worker: NodeWorker;
      constructor() {
        this.worker = new NodeWorker(
          `const { parentPort } = require('node:worker_threads');
          globalThis.postMessage = value => parentPort.postMessage(value);
          import(${JSON.stringify(pathToFileURL(config.workerAsset).href)}).then(() => {
            parentPort.on('message', value => { parentPort.postMessage({workerStarted:true}); globalThis.onmessage({data:value}); });
          });`,
          { eval: true },
        );
        workers.push(this.worker);
        this.worker.on("message", (data) => {
          if (data.workerStarted) onWorkerStart?.();
          else this.onmessage?.({ data } as MessageEvent);
        });
        this.worker.on("error", () => this.onerror?.());
      }
      postMessage(value: string) {
        this.worker.postMessage(value);
      }
      terminate() {
        void this.worker.terminate();
      }
    }
    vi.stubGlobal("Worker", ActualWorker);
    const bytes = new Uint8Array(readFileSync(config.fixture));

    const file = { name: "合成网页.html", size: bytes.length, arrayBuffer: async () => new Uint8Array(bytes).buffer } as File;
    const signal = () => new AbortController().signal;
    try {
      const plan = await prepareHTML(file, config.owner, signal());
      expect(plan.parsed.text).toContain("HTMLSourceNeedle");
      const dangerous = new TextEncoder().encode(
        `<title>attack</title><script>fetch('${trap}'); SCRIPT_EXECUTED</script><iframe src="${trap}" srcdoc="<script>fetch('${trap}')</script>"></iframe><img src="${trap}" srcset="${trap} 2x"><style>@import '${trap}'; p{background:url('${trap}')}</style><meta http-equiv="refresh" content="0;url=${trap}"><base href="${trap}"><svg onload="fetch('${trap}')"><image href="${trap}"/></svg><article><p>safe literal</p></article>`,
      );
      const attack = await prepareHTML(
        { name: "attack.html", size: dangerous.length, arrayBuffer: async () => new Uint8Array(dangerous).buffer } as File,
        config.owner,
        signal(),
      );
      expect(attack.parsed.text).toBe("safe literal");
      expect(requested).toBe(0);
      const cancelled = new AbortController();
      onWorkerStart = () => {
        cancelledAfterStart = true;
        cancelled.abort();
        onWorkerStart = undefined;
      };
      await expect(prepareHTML(file, config.owner, cancelled.signal)).rejects.toMatchObject({ name: "AbortError" });
      expect(cancelledAfterStart).toBe(true);
      expect(plan.parsed.text).not.toContain("SCRIPT_EXECUTED");
      expect(plan.parsed.title).toBe("合成网页标题");
      expect(plan.parsed.source).toBe("https://example.invalid/synthetic-source");
      expect((await call("GET", "memos")).memos ?? []).toHaveLength(0);
      const receipt = await saveHTML(plan, signal(), vi.fn());
      expect(receipt.status).toBe("imported");
      expect((await saveHTML(plan, signal(), vi.fn())).status).toBe("verified");
      expect((await call("GET", "attachments")).attachments).toHaveLength(1);
      const saved = await call("GET", receipt.memo);
      expect(saved.visibility).toBe("PRIVATE");
      expect(saved.content).toContain("合成网页标题");
      expect(saved.content).toContain("#source/link");
      expect(saved.content).toContain("<literal>");
      expect(saved.content).toContain("html-text-v1");
      const attachment = saved.attachments[0];
      const originalURL = `${config.base}/file/${attachment.name}/${encodeURIComponent(attachment.filename)}`;
      const downloaded = await nativeFetch(originalURL, { headers: { Authorization: `Bearer ${config.token}` } });
      expect(downloaded.headers.get("content-type")).toContain("application/zip");
      expect(downloaded.headers.get("content-disposition")).toContain("attachment");
      expect(downloaded.headers.get("x-content-type-options")).toBe("nosniff");
      expect(new Uint8Array(unzipSync(new Uint8Array(await downloaded.arrayBuffer()))[file.name])).toEqual(bytes);
      for (const token of [null, config.otherToken]) {
        const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
        for (const url of [`${config.base}/api/${receipt.memo}`, originalURL])
          expect([401, 403, 404]).toContain((await nativeFetch(url, { headers })).status);
      }
      const search = `memos?${new URLSearchParams({ filter: 'tag in ["source/link"] && content.contains("HTMLSourceNeedle")' })}`;
      expect((await call("GET", search)).memos).toHaveLength(1);
      expect((await call("GET", search, undefined, config.otherToken)).memos ?? []).toHaveLength(0);
      // Real owner edit prevents retry from overwriting the correction.
      await call("PATCH", `${receipt.memo}?updateMask=content`, { name: receipt.memo, content: saved.content + "\n人工后续编辑" });
      await expect(saveHTML(plan, signal(), vi.fn())).rejects.toThrow("已变化");
      // Another account cannot delete the source or its only archive.
      for (const name of [receipt.memo, attachment.name])
        expect([401, 403, 404]).toContain(
          (await nativeFetch(`${config.base}/api/${name}`, { method: "DELETE", headers: { Authorization: `Bearer ${config.otherToken}` } }))
            .status,
        );
      await call("DELETE", receipt.memo);
      expect((await nativeFetch(originalURL, { headers: { Authorization: `Bearer ${config.token}` } })).status).toBe(404);
      expect((await call("GET", search)).memos ?? []).toHaveLength(0);
      expect((await call("GET", "attachments")).attachments ?? []).toHaveLength(0);
      // Attachment is durably uploaded but memo creation fails before committing.
      rpc.createMemo.mockRejectedValueOnce(new ConnectError("synthetic write failure", Code.Internal));
      await expect(saveHTML(plan, signal(), vi.fn())).rejects.toThrow("未知");
      expect((await call("GET", "memos")).memos ?? []).toHaveLength(0);
      expect((await call("GET", "attachments")).attachments).toHaveLength(1);
      await saveHTML(plan, signal(), vi.fn());
      expect((await call("GET", "attachments")).attachments).toHaveLength(1);
      await call("DELETE", receipt.memo);
      // Actual commit followed by a deliberately lost response at the client boundary.
      rpc.createAttachment.mockImplementationOnce(async (args) => {
        await upload(args);
        throw new ConnectError("synthetic response loss", Code.Unavailable);
      });
      const receipts: string[] = [];
      await expect(saveHTML(plan, signal(), (r) => receipts.push(r.status))).rejects.toThrow("未知");
      expect(receipts).toContain("upload-unknown");
      expect((await call("GET", "attachments")).attachments).toHaveLength(1);
      await saveHTML(plan, signal(), vi.fn());
      expect((await call("GET", "attachments")).attachments).toHaveLength(1);
      await call("DELETE", receipt.memo);
      rpc.createMemo.mockImplementationOnce(async (args) => {
        await createMemo(args);
        throw new ConnectError("synthetic saved response loss", Code.Unavailable);
      });
      await expect(saveHTML(plan, signal(), vi.fn())).rejects.toThrow("未知");
      expect((await saveHTML(plan, signal(), vi.fn())).status).toBe("verified");
      expect((await call("GET", "attachments")).attachments).toHaveLength(1);
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
      await new Promise<void>((resolve) => sensor.close(() => resolve()));
      expect(requested).toBe(0);
      writeFileSync(
        config.workerEvidence,
        JSON.stringify({
          workers: workers.length,
          trap_requests: requested,
          cancelled_after_start: cancelledAfterStart,
          scheduler: "node:worker_threads; actual production worker asset, not browser",
        }),
      );
      vi.unstubAllGlobals();
    }
  },
  240_000,
);

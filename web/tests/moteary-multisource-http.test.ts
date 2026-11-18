import { File as NodeFile } from "node:buffer";
import { webcrypto } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Worker as NodeWorker } from "node:worker_threads";
import { Code, ConnectError } from "@connectrpc/connect";
import { unzipSync } from "fflate";
import { expect, it, vi } from "vitest";
import { audioWithTranscript, prepareAudio, saveAudio } from "@/components/MotearyWorkspace/audioImport";
import { prepareChat, saveChat } from "@/components/MotearyWorkspace/chatImport";
import { prepareHTML, saveHTML } from "@/components/MotearyWorkspace/htmlImport";
import { preparePastedText, saveManualText } from "@/components/MotearyWorkspace/manualTextImport";
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

it.skipIf(!process.env.YOUJI_MULTISOURCE_WEB_QA)(
  "captures four synthetic sources and retrieves one shared topic through real HTTP",
  async () => {
    const config = JSON.parse(process.env.YOUJI_MULTISOURCE_WEB_QA ?? "{}");
    const call = async (method: string, path: string, body?: object, token = config.token) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
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
    vi.stubGlobal("File", NodeFile);
    const workers: NodeWorker[] = [];
    class ProductionHTMLWorker {
      onmessage?: (event: MessageEvent) => void;
      onerror?: () => void;
      private worker: NodeWorker;
      constructor() {
        this.worker = new NodeWorker(
          `const {parentPort}=require('node:worker_threads');
           globalThis.postMessage=value=>parentPort.postMessage(value);
           globalThis.fetch=()=>{throw Error('Network forbidden in synthetic HTML worker')};
           import(${JSON.stringify(pathToFileURL(config.workerAsset).href)}).then(()=>{
             parentPort.on('message',value=>globalThis.onmessage({data:value}));
           });`,
          { eval: true },
        );
        workers.push(this.worker);
        this.worker.on("message", (data) => this.onmessage?.({ data } as MessageEvent));
        this.worker.on("error", () => this.onerror?.());
      }
      postMessage(value: string) {
        this.worker.postMessage(value);
      }
      terminate() {
        void this.worker.terminate();
      }
    }
    vi.stubGlobal("Worker", ProductionHTMLWorker);
    const file = (path: string, name: string) => {
      const data = new Uint8Array(readFileSync(path));
      return { name, size: data.length, arrayBuffer: async () => new Uint8Array(data).buffer } as File;
    };
    const signal = () => new AbortController().signal;
    const evidence: object[] = [];
    try {
      const pasted = await preparePastedText("SyntheticSharedTopic PasteNeedle 合成生活日记。", config.owner, {
        source: "diary",
        title: "合成日记",
      });
      const html = await prepareHTML(file(config.html, "synthetic.html"), config.owner, signal());
      const chat = await prepareChat(file(config.chat, "synthetic-chat.json"), config.owner);
      const audio = audioWithTranscript(
        await prepareAudio(file(config.audio, "synthetic.wav"), config.owner),
        "SyntheticSharedTopic AudioNeedle 合成录音人工稿；零PCM原件，不是语音转写。",
      );
      expect(html.parsed.text).toContain("HTMLNeedle");
      expect((await call("GET", "memos")).memos ?? []).toHaveLength(0);
      const cases = [
        { label: "paste", item: pasted.item, needle: "PasteNeedle", source: "text", save: () => saveManualText(pasted, signal(), vi.fn()) },
        { label: "html", item: html.item, needle: "HTMLNeedle", source: "link", save: () => saveHTML(html, signal(), vi.fn()) },
        { label: "chat", item: chat.item, needle: "ChatNeedle", source: "conversation", save: () => saveChat(chat, signal(), vi.fn()) },
        { label: "audio-manual", item: audio, needle: "AudioNeedle", source: "podcast", save: () => saveAudio(audio, signal(), vi.fn()) },
      ];
      for (const entry of cases) {
        const receipt = await entry.save();
        expect(receipt.status).toBe("imported");
        expect((await entry.save()).status).toBe("verified");
        const saved = await call("GET", receipt.memo);
        expect(saved.visibility).toBe("PRIVATE");
        expect(saved.content).toContain(entry.needle);
        expect(saved.attachments).toHaveLength(1);
        const attachment = saved.attachments[0];
        const url = `${config.base}/file/${attachment.name}/${encodeURIComponent(attachment.filename)}`;
        const downloaded = await nativeFetch(url, { headers: { Authorization: `Bearer ${config.token}` } });
        expect(downloaded.ok).toBe(true);
        const archive = unzipSync(new Uint8Array(await downloaded.arrayBuffer()));
        expect(Object.keys(archive)).toEqual([entry.item.filename]);
        expect(new Uint8Array(archive[entry.item.filename])).toEqual(entry.item.data);
        const filter = `tag in ["source/${entry.source}"] && content.contains("${entry.needle}")`;
        const found = (await call("GET", `memos?${new URLSearchParams({ filter })}`)).memos ?? [];
        expect(found.map((m: { name: string }) => m.name)).toEqual([receipt.memo]);
        const foreign = await nativeFetch(url, { headers: { Authorization: `Bearer ${config.otherToken}` } });
        expect([401, 403, 404]).toContain(foreign.status);
        evidence.push({
          source: entry.label,
          tag: entry.source,
          needle: entry.needle,
          memo: receipt.memo,
          filename: entry.item.filename,
          sha256: entry.item.sha256,
          bytes: entry.item.data.length,
          private: true,
          duplicate: "verified",
          original_bytes_equal: true,
        });
      }
      const shared = `memos?${new URLSearchParams({ filter: 'content.contains("SyntheticSharedTopic")' })}`;
      expect((await call("GET", shared)).memos).toHaveLength(4);
      expect((await call("GET", shared, undefined, config.otherToken)).memos ?? []).toHaveLength(0);
      expect((await call("GET", "memos")).memos).toHaveLength(4);
      expect((await call("GET", "attachments")).attachments).toHaveLength(4);
      writeFileSync(
        config.evidence,
        JSON.stringify({
          sources: evidence,
          shared_topic_count: 4,
          html_worker: "actual production asset under node:worker_threads, not browser",
          workers: workers.length,
        }),
      );
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
      vi.unstubAllGlobals();
    }
  },
  240_000,
);

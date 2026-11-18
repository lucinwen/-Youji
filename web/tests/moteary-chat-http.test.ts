import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { Code, ConnectError } from "@connectrpc/connect";
import { unzipSync } from "fflate";
import { expect, it, vi } from "vitest";
import { prepareChat, saveChat } from "@/components/MotearyWorkspace/chatImport";
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

it.skipIf(!process.env.YOUJI_CHAT_WEB_QA)(
  "runs actual chat module against real HTTP including recovery, isolation and deletion",
  async () => {
    const config = JSON.parse(process.env.YOUJI_CHAT_WEB_QA ?? "{}");
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
    let loseNextResponse = false;
    let failNextBeforeSend = false;
    vi.stubGlobal("fetch", async (url: string, options: RequestInit = {}) => {
      if (url === "/api/youji/chat-json/import" && failNextBeforeSend) {
        failNextBeforeSend = false;
        throw new Error("synthetic failure before dispatch");
      }
      const response = await nativeFetch(`${config.base}${url}`, {
        ...options,
        headers: { ...options.headers, Authorization: `Bearer ${config.token}` },
      });
      if (url === "/api/youji/chat-json/import" && loseNextResponse && response.ok) {
        loseNextResponse = false;
        await response.arrayBuffer();
        throw new Error("synthetic response loss after actual atomic commit");
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
    rpc.createMemo.mockImplementation(createMemo);
    const upload = ({ attachment }: { attachment: { content: Uint8Array } }) =>
      call("POST", "attachments", { ...attachment, content: Buffer.from(attachment.content).toString("base64") });
    rpc.createAttachment.mockImplementation(upload);
    rpc.getAttachment.mockImplementation(({ name }) => call("GET", name));
    rpc.listAttachments.mockImplementation(async (args) => {
      const result = await call("GET", `attachments?${new URLSearchParams(args)}`);
      return { attachments: result.attachments ?? [], nextPageToken: result.nextPageToken ?? "" };
    });
    const bytes = new Uint8Array(readFileSync(config.fixture));
    const file = { name: "合成聊天.json", size: bytes.length, arrayBuffer: async () => new Uint8Array(bytes).buffer } as File;
    const signal = () => new AbortController().signal;
    try {
      const plan = await prepareChat(file, config.owner);
      expect(plan.messages).toBe(2);
      expect(plan.service).toBe(1);
      expect(plan.media).toBe(1);
      expect((await call("GET", "memos")).memos ?? []).toHaveLength(0);
      const receipt = await saveChat(plan, signal(), vi.fn());
      expect(receipt.status).toBe("imported");
      expect((await saveChat(plan, signal(), vi.fn())).status).toBe("verified");
      expect((await call("GET", "attachments")).attachments).toHaveLength(1);
      const saved = await call("GET", receipt.memo);
      expect(saved.visibility).toBe("PRIVATE");
      expect(saved.content).toContain("[消息 10]");
      expect(saved.content).toContain("#source/conversation");
      expect(saved.content).toContain("<script>literal</script>");
      expect(saved.content).toContain("telegram-chat-v1");
      const attachment = saved.attachments[0];
      const originalURL = `${config.base}/file/${attachment.name}/${encodeURIComponent(attachment.filename)}`;
      const downloaded = await nativeFetch(originalURL, { headers: { Authorization: `Bearer ${config.token}` } });
      expect(new Uint8Array(unzipSync(new Uint8Array(await downloaded.arrayBuffer()))[file.name])).toEqual(bytes);
      for (const token of [null, config.otherToken]) {
        const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
        for (const url of [`${config.base}/api/${receipt.memo}`, originalURL])
          expect([401, 403, 404]).toContain((await nativeFetch(url, { headers })).status);
      }
      const search = `memos?${new URLSearchParams({ filter: 'tag in ["source/conversation"] && content.contains("ChatSourceNeedle")' })}`;
      expect((await call("GET", search)).memos).toHaveLength(1);
      expect((await call("GET", search, undefined, config.otherToken)).memos ?? []).toHaveLength(0);
      // Real owner edit prevents retry from overwriting the correction.
      await call("PATCH", `${receipt.memo}?updateMask=content`, { name: receipt.memo, content: saved.content + "\n人工后续编辑" });
      await expect(saveChat(plan, signal(), vi.fn())).rejects.toThrow("冲突");
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
      // Failure before dispatch creates neither a record nor an orphan original.
      failNextBeforeSend = true;
      await expect(saveChat(plan, signal(), vi.fn())).rejects.toThrow("未知");
      expect((await call("GET", "memos")).memos ?? []).toHaveLength(0);
      expect((await call("GET", "attachments")).attachments ?? []).toHaveLength(0);
      // The server really commits; only the completed client response is discarded.
      loseNextResponse = true;
      const receipts: string[] = [];
      await expect(saveChat(plan, signal(), (r) => receipts.push(r.status))).rejects.toThrow("未知");
      expect(receipts).toContain("save-unknown");
      expect((await call("GET", "memos")).memos).toHaveLength(1);
      expect((await call("GET", "attachments")).attachments).toHaveLength(1);
      expect((await saveChat(plan, signal(), vi.fn())).status).toBe("verified");
      expect((await call("GET", "attachments")).attachments).toHaveLength(1);
      expect(rpc.createAttachment).not.toHaveBeenCalled();
      expect(rpc.createMemo).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  },
  240_000,
);

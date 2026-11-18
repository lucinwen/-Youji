import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChatPlan, saveChat } from "@/components/MotearyWorkspace/chatImport";

const rpc = vi.hoisted(() => ({ getCurrentUser: vi.fn(), oldUpload: vi.fn() }));
vi.mock("@/connect", () => ({
  authServiceClient: { getCurrentUser: rpc.getCurrentUser },
  attachmentServiceClient: { createAttachment: rpc.oldUpload },
}));
vi.mock("@/auth-state", () => ({ getAccessToken: () => "synthetic-token" }));
const owner = "users/synthetic";
const fetchMock = vi.fn();
const plan = (size?: number): ChatPlan => ({
  item: {
    owner,
    id: `mwc-${"a".repeat(30)}`,
    filename: "合成聊天.json",
    data: size ? new TextEncoder().encode(`"${"x".repeat(size - 2)}"`) : new TextEncoder().encode('\uFEFF{"text":"合成原文"}\r\n'),
    sha256: "b".repeat(64),
    content: "#拾微\n#source/conversation\n合成聊天正文",
  },
  title: "合成聊天",
  transcript: "合成正文",
  messages: 1,
  service: 0,
  media: 0,
});
const signal = () => new AbortController().signal;
beforeEach(() => {
  fetchMock.mockReset();
  rpc.getCurrentUser.mockReset();
  rpc.oldUpload.mockReset();
  rpc.getCurrentUser.mockResolvedValue({ user: { name: owner } });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  expect(rpc.oldUpload).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
describe("chat JSON atomic original client", () => {
  it("sends only one authenticated chat JSON endpoint request with exact raw bytes", async () => {
    const value = plan();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          memo: `memos/${value.item.id}`,
          attachment: "attachments/ymc-synthetic",
          sha256: value.item.sha256,
          status: "imported",
        }),
      ),
    );
    const receipt = vi.fn();
    expect((await saveChat(value, signal(), receipt)).status).toBe("imported");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/youji/chat-json/import");
    expect(options).toEqual(expect.objectContaining({ credentials: "same-origin", cache: "no-store", redirect: "error" }));
    const body = JSON.parse(options.body);
    expect(body.owner).toBe(owner);
    expect(Object.keys(body).sort()).toEqual(["content", "data", "filename", "owner"]);
    expect([...Buffer.from(body.data, "base64")]).toEqual([...value.item.data]);
    expect(receipt.mock.calls.map(([r]) => r.status)).toEqual(["prepared", "save-unknown", "imported"]);
  });
  it("allows the chat JSON 512 KiB limit without widening manual text limits", async () => {
    const value = plan(512 * 1024);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          memo: `memos/${value.item.id}`,
          attachment: "attachments/ymc-synthetic",
          sha256: value.item.sha256,
          status: "verified",
        }),
      ),
    );
    expect((await saveChat(value, signal(), vi.fn())).status).toBe("verified");
    fetchMock.mockClear();
    await expect(saveChat(plan(512 * 1024 + 1), signal(), vi.fn())).rejects.toThrow("大小限制");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects account changes before any POST", async () => {
    rpc.getCurrentUser.mockResolvedValue({ user: { name: "users/other" } });
    await expect(saveChat(plan(), signal(), vi.fn())).rejects.toThrow("账户已变化");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([404, 501, 409])("does not fall back when chat JSON endpoint returns %s", async (status) => {
    fetchMock.mockResolvedValue(new Response("ignored", { status }));
    await expect(saveChat(plan(), signal(), vi.fn())).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/youji/chat-json/import");
  });
  it("keeps uncertain outcome when a completed response is unavailable", async () => {
    fetchMock.mockRejectedValue(new Error("synthetic response loss"));
    const receipt = vi.fn();
    await expect(saveChat(plan(), signal(), receipt)).rejects.toThrow("结果未知");
    expect(receipt.mock.calls.map(([r]) => r.status)).toEqual(["prepared", "save-unknown"]);
  });
});

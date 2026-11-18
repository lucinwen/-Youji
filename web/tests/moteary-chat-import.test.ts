import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareChat, saveChat } from "@/components/MotearyWorkspace/chatImport";

const saveAudio = vi.hoisted(() => vi.fn());
vi.mock("@/components/MotearyWorkspace/audioImport", () => ({ saveAudio }));
const owner = "users/synthetic";
const message = (id = 1) => ({ id, type: "message", date: "2026-11-18T10:00:00", from: "合成人物", text: "合成消息" });
const chat = (messages: unknown[] = [message()]) => ({ name: "合成单聊天", type: "personal_chat", id: 123, messages });
const file = (source: unknown, name = "synthetic-chat.json") => {
  const data = new TextEncoder().encode(JSON.stringify(source));
  return { name, size: data.length, arrayBuffer: async () => new Uint8Array(data).buffer } as File;
};
const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  saveAudio.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("Telegram single-chat local parsing", () => {
  it("joins strings and text entities without following links or interpreting HTML", async () => {
    const source = chat([
      {
        ...message(),
        text: [
          "before ",
          { type: "text_link", text: "<img src=x onerror=alert(1)>", href: "https://example.invalid/private" },
          " ``` after",
        ],
      },
      { ...message(2), text: "literal https://example.invalid/only-text", reply_to_message_id: 1 },
    ]);
    const plan = await prepareChat(file(source), owner);
    expect(plan.transcript).toContain("before <img src=x onerror=alert(1)> ``` after");
    expect(plan.transcript).not.toContain("https://example.invalid/private");
    expect(plan.transcript).toContain("literal https://example.invalid/only-text");
    expect(plan.transcript).toContain("回复 1");
    expect(plan.item.content).toContain("\n````\n");
    expect(plan.item.content).toContain("#source/conversation");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saveAudio).not.toHaveBeenCalled();
  });
  it("counts service messages and marks media without claiming media import", async () => {
    const plan = await prepareChat(
      file(
        chat([
          { id: 1, type: "service", action: "create_group", actor: "合成人物" },
          { ...message(2), text: "", from: undefined, photo: "photos/synthetic.jpg" },
          { ...message(3), file: "voice/synthetic.ogg", media_type: "voice_message", poll: {} },
        ]),
      ),
      owner,
    );
    expect(plan.messages).toBe(2);
    expect(plan.service).toBe(1);
    expect(plan.media).toBe(2);
    expect(plan.transcript).toContain("未知发言人");
    expect(plan.transcript).toContain("（无文字正文）");
    expect(plan.transcript).toContain("本入口未导入或解析");
    expect(plan.transcript).not.toContain("create_group");
    expect(plan.transcript).not.toContain("photos/synthetic.jpg");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("binds stable identity to exact original bytes, filename and owner", async () => {
    const source = file(chat());
    const first = await prepareChat(source, owner);
    const repeated = await prepareChat(source, owner);
    expect(repeated.item.id).toBe(first.item.id);
    expect(repeated.item.sha256).toBe(first.item.sha256);
    expect(first.item.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.item.id).toMatch(/^mwc-[a-f0-9]{30}$/);
    expect(first.item.data).toEqual(new Uint8Array(await source.arrayBuffer()));
    expect((await prepareChat(source, "users/other")).item.id).not.toBe(first.item.id);
    expect((await prepareChat(file(chat(), "renamed.json"), owner)).item.id).not.toBe(first.item.id);
    expect((await prepareChat(file(chat([{ ...message(), text: "changed" }])), owner)).item.id).not.toBe(first.item.id);
  });
  it.each([
    ["whole account", { chats: { list: [chat()] } }],
    ["duplicate IDs", chat([message(), message()])],
    ["service duplicate IDs", chat([{ id: 1, type: "service" }, message()])],
    ["unsupported message", chat([{ ...message(), type: "unsupported" }])],
    ["rich_message", chat([{ ...message(), type: "rich_message" }])],
    ["rich field with fallback text", chat([{ ...message(), rich_message: {} }])],
    ["malformed entity", chat([{ ...message(), text: [{ type: "bold", text: 5 }] }])],
    ["nested body", chat([{ ...message(), text: { text: "unexpected" } }])],
    ["only service", chat([{ id: 1, type: "service" }])],
    ["empty list", chat([])],
    ["bad reply", chat([{ ...message(), reply_to_message_id: "1" }])],
    ["bad sender", chat([{ ...message(), from: { name: "synthetic" } }])],
    ["bad date", chat([{ ...message(), date: "" }])],
  ])("rejects %s before any network or save", async (_label, source) => {
    await expect(prepareChat(file(source), owner)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saveAudio).not.toHaveBeenCalled();
  });
  it("accepts 1000 records and rejects 1001 without truncation", async () => {
    const messages = Array.from({ length: 1000 }, (_, index) => message(index + 1));
    expect((await prepareChat(file(chat(messages)), owner)).messages).toBe(1000);
    await expect(prepareChat(file(chat([...messages, message(1001)])), owner)).rejects.toThrow("1–1000");
  });
  it("bounds declared and actual bytes, output size and strict UTF-8 before upload", async () => {
    const source = file(chat());
    await expect(prepareChat({ ...source, size: 512 * 1024 + 1 } as File, owner)).rejects.toThrow("512 KiB");
    await expect(
      prepareChat({ ...source, size: 1, arrayBuffer: async () => new Uint8Array(512 * 1024 + 1).buffer } as File, owner),
    ).rejects.toThrow("大小限制");
    await expect(prepareChat({ ...source, size: 1, arrayBuffer: async () => new Uint8Array([255]).buffer } as File, owner)).rejects.toThrow(
      "UTF-8 JSON",
    );
    await expect(prepareChat(file(chat([{ ...message(), text: "a".repeat(256 * 1024) }])), owner)).rejects.toThrow("不会截断");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects invalid owner and unsafe filenames", async () => {
    await expect(prepareChat(file(chat()), "wrong")).rejects.toThrow("登录");
    for (const name of ["../chat.json", "chat.txt", "bad\nchat.json"])
      await expect(prepareChat(file(chat(), name), owner)).rejects.toThrow("文件名");
  });
  it("delegates saving only explicitly to the existing single-original protocol", async () => {
    const plan = await prepareChat(file(chat()), owner);
    const signal = new AbortController().signal;
    const receipt = vi.fn();
    saveAudio.mockResolvedValue({ memo: `memos/${plan.item.id}`, status: "verified" });
    expect(await saveChat(plan, signal, receipt)).toEqual({ memo: `memos/${plan.item.id}`, status: "verified" });
    expect(saveAudio).toHaveBeenCalledWith(plan.item, signal, receipt);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

it.each([
  "invoice_information",
  "giveaway_information",
  "game_title",
  "game_link",
  "contact_vcard",
  "thumbnail",
])("marks omitted structured field %s even with an empty text", async (field) => {
  const plan = await prepareChat(file(chat([{ ...message(), text: "", [field]: "not fetched" }])), owner);
  expect(plan.media).toBe(1);
  expect(plan.transcript).toContain("未导入或解析");
  expect(fetchMock).not.toHaveBeenCalled();
});

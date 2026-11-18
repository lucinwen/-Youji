import { File as NodeFile } from "node:buffer";
import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ManualSource,
  prepareManualText,
  preparePastedText,
  SOURCES,
  saveManualText,
} from "@/components/MotearyWorkspace/manualTextImport";
import { getSourceTitle } from "@/components/MotearyWorkspace/sources";

const saveAudio = vi.hoisted(() => vi.fn());
const getCurrentUser = vi.hoisted(() => vi.fn());
vi.mock("@/components/MotearyWorkspace/audioImport", () => ({ saveAudio }));
vi.mock("@/connect", () => ({ authServiceClient: { getCurrentUser } }));
vi.mock("@/auth-state", () => ({ getAccessToken: () => "synthetic-refreshed-token" }));
const owner = "users/synthetic";
const options = { source: "wechat" as const, title: "合成对话" };
const encode = (text: string) => new TextEncoder().encode(text);
const file = (value: string | Uint8Array, name = "合成.txt", size?: number) => {
  const data = typeof value === "string" ? encode(value) : value;
  return { name, size: size ?? data.length, arrayBuffer: async () => new Uint8Array(data).buffer } as File;
};
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("File", NodeFile);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  saveAudio.mockReset();
  getCurrentUser.mockReset().mockResolvedValue({ user: { name: owner } });
});
afterEach(() => {
  expect(saveAudio).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("manual UTF-8 originals and pasted snapshots", () => {
  afterEach(() => expect(fetchMock).not.toHaveBeenCalled());
  it.each([
    "普通合成标题",
    "```<img src=x onerror=alert(1)>",
    "[标题](https://example.invalid/private)",
  ])("extracts the actual card title as literal text: %s", async (title) => {
    const plan = await prepareManualText(file("正文"), owner, { ...options, title });
    expect(getSourceTitle(plan.item.content)).toBe(title);
  });

  it("limits the card title to 110 characters without changing the original metadata", async () => {
    const title = "长标题".repeat(60);
    const plan = await prepareManualText(file("正文"), owner, { ...options, title });
    expect(getSourceTitle(plan.item.content)).toBe(title.slice(0, 110));
    expect(plan.title).toBe(title);
    expect(plan.item.content).toContain(title);
  });

  it("preserves exact UTF-8 bytes, CRLF, tabs, spaces and non-BMP characters", async () => {
    const text = "  合成对话 😀\r\n第二行\t末尾空格  \r\n";
    const data = encode(text);
    const plan = await prepareManualText(file(data), owner, options);
    expect(plan.text).toBe(text);
    expect(Array.from(plan.item.data)).toEqual(Array.from(data));
    expect(plan.item.sha256).toBe(createHash("sha256").update(data).digest("hex"));
    expect(plan.item.content).toContain(`\n\`\`\`\n${text}\n\`\`\`\n`);
    expect(saveAudio).not.toHaveBeenCalled();
  });

  it("keeps a UTF-8 BOM in the original and hash while decoding the display text", async () => {
    const text = "合成 BOM\r\n";
    const data = new Uint8Array([0xef, 0xbb, 0xbf, ...encode(text)]);
    const plan = await prepareManualText(file(data), owner, options);
    const withoutBOM = await prepareManualText(file(text), owner, options);
    expect(plan.text).toBe(text);
    expect(Array.from(plan.item.data)).toEqual(Array.from(data));
    expect(plan.item.sha256).not.toBe(withoutBOM.item.sha256);
    expect(plan.item.id).not.toBe(withoutBOM.item.id);
  });

  it("keeps hostile HTML, Markdown and links literal inside a longer code fence", async () => {
    const text =
      '<script>fetch("https://example.invalid/private")</script>\n<img src=x onerror=alert(1)>\n![x](https://example.invalid/image)\n`````\n# spoofed-heading';
    const plan = await prepareManualText(file(text, "合成.md"), owner, { ...options, title: "```<img src=x>" });
    expect(plan.text).toBe(text);
    expect(plan.item.content).toContain(`\n\`\`\`\`\`\`\n${text}\n\`\`\`\`\`\`\n`);
    expect(plan.item.content).toContain("```<img src=x>");
    expect(plan.item.content).toContain("未验证发言人、时间或内容真实性，未自动转写");
    expect(saveAudio).not.toHaveBeenCalled();
  });

  it.each([
    ["unspecified", "reference", "text"],
    ["wechat", "reference", "conversation"],
    ["friends", "reference", "conversation"],
    ["lecture", "reference", "text"],
    ["podcast", "reference", "podcast"],
    ["diary", "diary", "text"],
    ["work", "work", "text"],
    ["idea", "idea", "text"],
  ] as const)("maps %s to its source and category without claiming automated acquisition", async (source, category, kind) => {
    const plan = await prepareManualText(file("合成正文"), owner, { source, title: "  合成标题  " });
    expect(plan.source).toBe(source);
    expect(plan.title).toBe("合成标题");
    expect(plan.item.content).toContain(`#拾微 #${category} #source/${kind}`);
    expect(plan.item.content).toContain(SOURCES[source]);
    expect(plan.item.content).toContain("未连接微信或其他平台");
    expect(plan.item.content).toContain(plan.item.sha256);
  });

  it("uses the filename for an empty title and preserves metadata conflicts under the original identity", async () => {
    const first = await prepareManualText(file("原文"), owner, { ...options, title: "  " });
    expect(first.title).toBe("合成.txt");
    const changed = await prepareManualText(file("原文"), owner, { source: "work", title: "新标题" });
    expect(changed.item.id).toBe(first.item.id);
    expect(changed.item.content).not.toBe(first.item.content);
  });

  it("binds stable IDs to owner, exact bytes and filename", async () => {
    const first = await prepareManualText(file("相同\r\n"), owner, options);
    expect((await prepareManualText(file("相同\r\n"), owner, options)).item).toEqual(first.item);
    expect(first.item.id).toMatch(/^mwt-[a-f0-9]{30}$/);
    for (const [input, account] of [
      [file("相同\r\n"), "users/other"],
      [file("相同\n"), owner],
      [file("相同\r\n", "renamed.txt"), owner],
    ] as const) {
      expect((await prepareManualText(input, account, options)).item.id).not.toBe(first.item.id);
    }
  });

  it("accepts exactly 128 KiB and rejects one more byte before saving", async () => {
    const text = `${"中".repeat(43690)}ab`;
    expect(encode(text)).toHaveLength(128 * 1024);
    expect((await prepareManualText(file(text), owner, options)).text).toBe(text);
    await expect(prepareManualText(file(`${text}c`), owner, options)).rejects.toThrow("128 KiB");
    await expect(prepareManualText(file(`${text}c`, "合成.txt", 1), owner, options)).rejects.toThrow("大小限制");
    await expect(preparePastedText(`${text}c`, owner, options)).rejects.toThrow("128 KiB");
    expect(saveAudio).not.toHaveBeenCalled();
  });

  it.each(["", " \t\r\n", "正文\0", "正文\u0007", "正文\u007f"])("rejects empty/control input %j", async (text) => {
    await expect(prepareManualText(file(text), owner, options)).rejects.toThrow();
    expect(saveAudio).not.toHaveBeenCalled();
  });

  it("rejects malformed UTF-8 rather than replacing bytes", async () => {
    await expect(prepareManualText(file(new Uint8Array([0xc3, 0x28])), owner, options)).rejects.toThrow("有效 UTF-8");
  });

  it("rejects expanded code fences exceeding the saved-body limit instead of truncating", async () => {
    await expect(prepareManualText(file("`".repeat(128 * 1024)), owner, options)).rejects.toThrow("256 KiB");
    expect(saveAudio).not.toHaveBeenCalled();
  });

  it.each([
    ".notes.txt",
    " notes.txt",
    "../secret.txt",
    "bad\\name.md",
    "file.html",
    "file\n.txt",
    `${"a".repeat(237)}.txt`,
  ])("rejects unsafe or unsupported filename %j", async (name) => {
    await expect(prepareManualText(file("正文", name), owner, options)).rejects.toThrow("文件名");
  });

  it("rejects invalid owner and metadata before reading the original", async () => {
    const input = file("正文");
    const read = vi.spyOn(input, "arrayBuffer");
    await expect(prepareManualText(input, "users/../other", options)).rejects.toThrow("登录");
    for (const invalid of [
      { source: "toString" as ManualSource, title: "标题" },
      { source: "__proto__" as ManualSource, title: "标题" },
      { ...options, title: "x".repeat(201) },
      { ...options, title: "标题\n伪造" },
    ]) {
      await expect(prepareManualText(input, owner, invalid)).rejects.toThrow("来源无效");
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("captures pasted text at preview time with a deterministic generated filename", async () => {
    let draft = "合成粘贴\r\n第一版";
    const original = draft;
    const preparing = preparePastedText(draft, owner, options);
    draft = "第二版";
    const plan = await preparing;
    expect(plan.text).toBe(original);
    expect(Array.from(plan.item.data)).toEqual(Array.from(encode(original)));
    expect(plan.item.filename).toBe(`手动文本-${createHash("sha256").update(original).digest("hex").slice(0, 12)}.txt`);
    expect((await preparePastedText(original, owner, options)).item.id).toBe(plan.item.id);
    expect((await preparePastedText(draft, owner, options)).item.id).not.toBe(plan.item.id);
    expect((await preparePastedText(original, "users/other", options)).item.id).not.toBe(plan.item.id);
    expect(plan.item.content).toContain("预览时文本快照，不是平台导出或媒体备份");
    expect(saveAudio).not.toHaveBeenCalled();
  });
});

describe("dedicated transactional manual-text save", () => {
  it.each(["imported", "verified"])("authenticates first and sends exact bytes only to the new endpoint for %s", async (status) => {
    const data = new Uint8Array([0xef, 0xbb, 0xbf, ...encode("合成原文\r\n😀")]);
    const plan = await prepareManualText(file(data), owner, options);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ memo: `memos/${plan.item.id}`, attachment: "attachments/synthetic", status, sha256: plan.item.sha256 }),
      ),
    );
    const signal = new AbortController().signal;
    const receipt = vi.fn();
    const result = await saveManualText(plan, signal, receipt);
    expect(result).toEqual(expect.objectContaining({ status, attachment: "attachments/synthetic", sha256: plan.item.sha256 }));
    expect(receipt.mock.calls.map(([value]) => value.status)).toEqual(["prepared", "save-unknown", status]);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "/api/youji/manual-text/import",
      expect.objectContaining({
        method: "POST",
        signal,
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Authorization: "Bearer synthetic-refreshed-token" },
      }),
    );
    expect(getCurrentUser).toHaveBeenCalledWith({}, { signal });
    expect(getCurrentUser.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(Object.keys(body).sort()).toEqual(["content", "data", "filename", "owner"]);
    expect(body).toEqual(expect.objectContaining({ owner, filename: plan.item.filename, content: plan.item.content }));
    expect([...Buffer.from(body.data, "base64")]).toEqual([...data]);
  });
  it("rejects a changed account before POST and does not issue an unknown-write receipt", async () => {
    const plan = await preparePastedText("合成", owner, options);
    getCurrentUser.mockResolvedValueOnce({ user: { name: "users/other" } });
    const receipt = vi.fn();
    await expect(saveManualText(plan, new AbortController().signal, receipt)).rejects.toThrow("账户已变化");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(receipt.mock.calls.map(([value]) => value.status)).toEqual(["prepared"]);
  });
  it.each([
    [404, "更新服务器并使用 SQLite"],
    [501, "更新服务器并使用 SQLite"],
    [409, "不会覆盖或自动迁移"],
    [413, "大小限制"],
    [422, "服务器拒绝输入"],
    [429, "配额不足或服务正忙"],
    [403, "无权保存"],
    [401, "登录已失效"],
    [500, "保存未能确认"],
  ] as const)("reports HTTP %s without fallback and retains the unknown-write receipt", async (status, message) => {
    const plan = await preparePastedText("合成", owner, options);
    fetchMock.mockResolvedValueOnce(new Response("ignored server body", { status }));
    const receipt = vi.fn();
    await expect(saveManualText(plan, new AbortController().signal, receipt)).rejects.toThrow(message);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(receipt.mock.lastCall?.[0]).toEqual(expect.objectContaining({ memo: `memos/${plan.item.id}`, status: "save-unknown" }));
  });
  it("keeps an uncertain receipt when the request response is lost", async () => {
    const plan = await preparePastedText("合成", owner, options);
    fetchMock.mockRejectedValueOnce(new TypeError("network failure"));
    const receipt = vi.fn();
    await expect(saveManualText(plan, new AbortController().signal, receipt)).rejects.toThrow("结果未知");
    expect(receipt.mock.lastCall?.[0].status).toBe("save-unknown");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it.each([
    { memo: "memos/wrong" },
    { attachment: "https://example.invalid/remote" },
    { status: "uploaded" },
    { sha256: "wrong" },
  ])("rejects inconsistent successful response fields %#", async (patch) => {
    const plan = await preparePastedText("合成", owner, options);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          memo: `memos/${plan.item.id}`,
          attachment: "attachments/synthetic",
          status: "imported",
          sha256: plan.item.sha256,
          ...patch,
        }),
      ),
    );
    const receipt = vi.fn();
    await expect(saveManualText(plan, new AbortController().signal, receipt)).rejects.toThrow("回执与原件不匹配");
    expect(receipt.mock.lastCall?.[0].status).toBe("save-unknown");
  });
  it.each(["invalid JSON", "x".repeat(16 * 1024 + 1)])("bounds and validates the response body %#", async (body) => {
    const plan = await preparePastedText("合成", owner, options);
    fetchMock.mockResolvedValueOnce(new Response(body));
    const receipt = vi.fn();
    await expect(saveManualText(plan, new AbortController().signal, receipt)).rejects.toThrow("响应格式或大小异常");
    expect(receipt.mock.lastCall?.[0].status).toBe("save-unknown");
  });
  it("does not POST after cancellation while identity refresh is pending", async () => {
    const plan = await preparePastedText("合成", owner, options);
    const abort = new AbortController();
    getCurrentUser.mockImplementationOnce(async () => {
      abort.abort();
      return { user: { name: owner } };
    });
    await expect(saveManualText(plan, abort.signal, vi.fn())).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("never emits final success after cancellation even if the POST resolved", async () => {
    const plan = await preparePastedText("合成", owner, options);
    const abort = new AbortController();
    fetchMock.mockImplementationOnce(async () => {
      abort.abort();
      return new Response(
        JSON.stringify({
          memo: `memos/${plan.item.id}`,
          attachment: "attachments/synthetic",
          status: "imported",
          sha256: plan.item.sha256,
        }),
      );
    });
    const receipt = vi.fn();
    await expect(saveManualText(plan, abort.signal, receipt)).rejects.toThrow();
    expect(receipt.mock.lastCall?.[0].status).toBe("save-unknown");
  });
});

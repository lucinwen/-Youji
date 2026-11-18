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
vi.mock("@/components/MotearyWorkspace/audioImport", () => ({ saveAudio }));
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
});
afterEach(() => {
  expect(fetchMock).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("manual UTF-8 originals and pasted snapshots", () => {
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

  it("forwards the exact plan, cancellation signal and receipt callback to the established save protocol", async () => {
    const plan = await preparePastedText("保存合成原文", owner, options);
    const signal = new AbortController().signal;
    const receipt = vi.fn();
    const result = { status: "verified", memo: `memos/${plan.item.id}` };
    saveAudio.mockResolvedValue(result);
    expect(await saveManualText(plan, signal, receipt)).toBe(result);
    expect(saveAudio).toHaveBeenCalledExactlyOnceWith(plan.item, signal, receipt);
  });
});

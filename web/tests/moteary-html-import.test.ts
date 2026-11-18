import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseHTMLInWorker, prepareHTML, saveHTML } from "@/components/MotearyWorkspace/htmlImport";
import { extractHTML } from "@/components/MotearyWorkspace/htmlText";

const saveAtomicOriginal = vi.hoisted(() => vi.fn());
vi.mock("@/components/MotearyWorkspace/atomicOriginalImport", () => ({ saveAtomicOriginal }));
const owner = "users/synthetic";
const file = (html: string, name = "synthetic.html") => {
  const bytes = new TextEncoder().encode(html);
  return { name, size: bytes.length, arrayBuffer: async () => new Uint8Array(bytes).buffer } as File;
};
const fetchMock = vi.fn();
class ParserWorker {
  static instances: ParserWorker[] = [];
  static automatic = true;
  onmessage?: (event: MessageEvent) => void;
  onerror?: () => void;
  terminate = vi.fn();
  postMessage = vi.fn((html: string) => {
    if (ParserWorker.automatic) queueMicrotask(() => this.onmessage?.({ data: { result: extractHTML(html) } } as MessageEvent));
  });
  constructor() {
    ParserWorker.instances.push(this);
  }
}
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("Worker", ParserWorker);
  fetchMock.mockReset();
  saveAtomicOriginal.mockReset();
  ParserWorker.instances = [];
  ParserWorker.automatic = true;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Pure parse5 HTML text extraction", () => {
  it("extracts long Chinese paragraphs and entities with self-declared metadata", () => {
    const paragraphs = Array.from({ length: 150 }, (_, index) => `<p>第${index}段：合成中文材料 &amp; &#x4E2D; &lt;literal&gt;</p>`).join(
      "",
    );
    const parsed = extractHTML(
      `<title>合成 &amp; 标题</title><meta name="author" content="合成作者"><link rel="alternate canonical" href="https://example.invalid/source"><article>${paragraphs}</article>`,
    );
    expect(parsed.title).toBe("合成 & 标题");
    expect(parsed.author).toBe("合成作者");
    expect(parsed.source).toBe("https://example.invalid/source");
    expect(parsed.text).toContain("第149段：合成中文材料 & 中 <literal>");
    expect(parsed.selection).toBe("article");
    expect(parsed.nodes).toBeGreaterThan(150);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("selects the first visible article before main, otherwise first main then body", () => {
    expect(extractHTML("<main>main first</main><article>first article</article><article>second</article>").text).toBe("first article");
    expect(extractHTML("<div hidden><article>hidden article</article></div><main>first main</main><main>second main</main>").text).toBe(
      "first main",
    );
    expect(extractHTML("<template><article>template article</article></template><p>body text</p>").selection).toBe("body");
    expect(extractHTML("<nav><article>nav article</article></nav><p>body text</p>").text).toBe("body text");
  });
  it("keeps adjacent table headers and numeric cells separated", () => {
    const parsed = extractHTML(
      "<article><table><tr><th>日期</th><th>金额</th></tr><tr><td>2026</td><td>100</td></tr><tr><td>2027</td><td>200</td></tr></table></article>",
    );
    expect(parsed.text).not.toContain("2026100");
    expect(parsed.text).not.toContain("日期金额");
    expect(parsed.text).toMatch(/2026\s+100/);
    expect(parsed.text).toMatch(/2027\s+200/);
  });
  it("does not execute or fetch scripts, styles, frames, SVG, forms or linked resources", () => {
    const trigger = vi.fn();
    vi.stubGlobal("htmlTestTrigger", trigger);
    const parsed = extractHTML(`<link rel="stylesheet" href="https://example.invalid/theme.css"><article>
      <p>VISIBLE</p><script>globalThis.htmlTestTrigger();fetch('https://example.invalid')</script>
      <style>@import 'https://example.invalid/extra.css';CSS_SECRET</style><noscript>NOSCRIPT_SECRET</noscript>
      <iframe src="https://example.invalid/frame">IFRAME_SECRET</iframe><svg onload="htmlTestTrigger()"><text>SVG_SECRET</text></svg>
      <form action="https://example.invalid/post">FORM_SECRET<input value="INPUT_SECRET"></form><textarea>TEXTAREA_SECRET</textarea>
      <object data="https://example.invalid/object">OBJECT_SECRET</object><embed src="https://example.invalid/embed">
      <div hidden>HIDDEN_SECRET</div><div aria-hidden="TRUE">ARIA_SECRET</div><div style="display: none">DISPLAY_SECRET</div>
      <div style="visibility:hidden">VISIBILITY_SECRET</div><aside>ASIDE_SECRET</aside><footer>FOOTER_SECRET</footer>
      <img src="https://example.invalid/pixel" onerror="htmlTestTrigger()" alt="ALT_SECRET"><a href="https://example.invalid/link">ANCHOR_TEXT</a>
      </article>`);
    expect(parsed.text).toContain("VISIBLE");
    expect(parsed.text).toContain("ANCHOR_TEXT");
    expect(parsed.text).not.toContain("SECRET");
    expect(parsed.text).not.toContain("https://");
    expect(trigger).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.querySelector("iframe,svg,form,img")).toBeNull();
  });
  it.each([
    "javascript:alert(1)",
    "/relative",
    "file:///private",
    "https://example.invalid/" + "x".repeat(2048),
  ])("does not treat unsafe or oversized canonical %s as source", (url) => {
    expect(extractHTML(`<link rel="canonical" href="${url}"><p>text</p>`).source).toBe("");
  });
  it("rejects no-text pages, input/output oversize, excessive depth and excessive nodes", () => {
    expect(() => extractHTML("<script>only script</script><img src=x>")).toThrow("未找到可提取文字");
    expect(() => extractHTML("x".repeat(512 * 1024 + 1))).toThrow("512 KiB");
    expect(() => extractHTML(`<p>${"字".repeat(90000)}</p>`)).toThrow("256 KiB");
    expect(() => extractHTML(`${"<div>".repeat(130)}text${"</div>".repeat(130)}`)).toThrow("过大或过深");
    expect(() => extractHTML(`<article>${"<span>x</span>".repeat(5100)}</article>`)).toThrow("过大或过深");
  });
});

describe("HTML worker and source plan", () => {
  it("preserves original bytes and stable owner/hash/filename identity without network", async () => {
    const source = file("<title>合成</title><article>正文 ``` &lt;img&gt;</article>");
    const first = await prepareHTML(source, owner, new AbortController().signal);
    expect(first.item.data).toEqual(new Uint8Array(await source.arrayBuffer()));
    expect(first.item.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.item.id).toMatch(/^mwh-[a-f0-9]{30}$/);
    expect(first.item.content).toContain("#source/link");
    expect(first.item.content).toContain("\n````\n");
    expect((await prepareHTML(source, owner, new AbortController().signal)).item.id).toBe(first.item.id);
    expect((await prepareHTML(source, "users/other", new AbortController().signal)).item.id).not.toBe(first.item.id);
    expect((await prepareHTML(file("<p>different</p>"), owner, new AbortController().signal)).item.id).not.toBe(first.item.id);
    expect(ParserWorker.instances.every((worker) => worker.terminate.mock.calls.length === 1)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saveAtomicOriginal).not.toHaveBeenCalled();
  });
  it("terminates a pending worker on cancellation and ignores its late response", async () => {
    ParserWorker.automatic = false;
    const abort = new AbortController();
    const promise = parseHTMLInWorker("<p>text</p>", abort.signal);
    const rejected = expect(promise).rejects.toThrow("已取消");
    const worker = ParserWorker.instances[0];
    abort.abort();
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
    worker.onmessage?.({ data: { result: extractHTML("<p>late</p>") } } as MessageEvent);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("terminates a stuck worker after five seconds", async () => {
    vi.useFakeTimers();
    ParserWorker.automatic = false;
    const promise = parseHTMLInWorker("<p>text</p>", new AbortController().signal);
    const rejected = expect(promise).rejects.toThrow("5 秒");
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(ParserWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });
  it("does not start a worker when already aborted and reports startup failure", async () => {
    const abort = new AbortController();
    abort.abort();
    expect(() => parseHTMLInWorker("text", abort.signal)).toThrow();
    expect(ParserWorker.instances).toHaveLength(0);
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          throw new Error("unsupported");
        }
      },
    );
    await expect(parseHTMLInWorker("text", new AbortController().signal)).rejects.toThrow("无法启动");
  });
  it.each(["error", "invalid", "parser"])("terminates on worker %s output", async (kind) => {
    ParserWorker.automatic = false;
    const promise = parseHTMLInWorker("text", new AbortController().signal);
    const rejected = expect(promise).rejects.toThrow();
    const worker = ParserWorker.instances[0];
    if (kind === "error") worker.onerror?.();
    else worker.onmessage?.({ data: kind === "parser" ? { error: "synthetic parser failure" } : {} } as MessageEvent);
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it("rejects invalid input and aborts after local file read before starting a worker", async () => {
    const source = file("<p>text</p>");
    await expect(prepareHTML({ ...source, size: 512 * 1024 + 1 } as File, owner, new AbortController().signal)).rejects.toThrow("512 KiB");
    await expect(
      prepareHTML(
        { ...source, size: 1, arrayBuffer: async () => new Uint8Array([255]).buffer } as File,
        owner,
        new AbortController().signal,
      ),
    ).rejects.toThrow("UTF-8");
    const abort = new AbortController();
    await expect(
      prepareHTML(
        {
          ...source,
          arrayBuffer: async () => {
            abort.abort();
            return source.arrayBuffer();
          },
        } as File,
        owner,
        abort.signal,
      ),
    ).rejects.toThrow();
    expect(ParserWorker.instances).toHaveLength(0);
  });
  it.each([".hidden.html", " spaced.html", "bad.txt"])("rejects unsupported filename %s before worker startup", async (name) => {
    await expect(prepareHTML(file("<p>text</p>", name), owner, new AbortController().signal)).rejects.toThrow("文件名有效");
    expect(ParserWorker.instances).toHaveLength(0);
  });
  it("uses the dedicated HTML atomic save protocol only after an explicit save", async () => {
    const signal = new AbortController().signal;
    const plan = await prepareHTML(file("<p>正文</p>"), owner, signal);
    const receipt = vi.fn();
    saveAtomicOriginal.mockResolvedValue({ status: "verified" });
    expect(await saveHTML(plan, signal, receipt)).toEqual({ status: "verified" });
    expect(saveAtomicOriginal).toHaveBeenCalledWith(plan.item, "html", signal, receipt);
  });
});

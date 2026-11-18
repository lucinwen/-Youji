import { type DefaultTreeAdapterTypes, parse } from "parse5";

export type HTMLText = { title: string; author: string; source: string; text: string; selection: string; nodes: number };
type Node = DefaultTreeAdapterTypes.Node;
const blocked = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "object",
  "embed",
  "svg",
  "math",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "nav",
  "aside",
  "footer",
]);
const blocks = new Set([
  "p",
  "div",
  "section",
  "article",
  "main",
  "header",
  "h1",
  "h2",
  "h3",
  "h4",
  "li",
  "ul",
  "ol",
  "blockquote",
  "pre",
  "tr",
  "td",
  "th",
  "table",
  "br",
  "hr",
]);
const children = (node: Node): Node[] => ("childNodes" in node ? node.childNodes : []);
const attr = (node: Node, name: string) => ("attrs" in node ? (node.attrs.find((entry) => entry.name === name)?.value ?? "") : "");
const tag = (node: Node) => ("tagName" in node ? node.tagName : "");
const hidden = (node: Node) =>
  "attrs" in node &&
  (node.attrs.some((a) => a.name === "hidden") ||
    attr(node, "aria-hidden").toLowerCase() === "true" ||
    /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attr(node, "style")));

/** Pure parse5 AST traversal: never creates a browser document, runs code or resolves resources. */
export function extractHTML(html: string): HTMLText {
  if (new TextEncoder().encode(html).length > 512 * 1024) throw new Error("HTML 超过 512 KiB。");
  const root = parse(html, { scriptingEnabled: true });
  const pending: Array<[Node, number]> = [[root, 0]];
  const all: Node[] = [];
  while (pending.length) {
    const [node, depth] = pending.pop()!;
    if (all.length >= 10000 || depth > 128) throw new Error("HTML 结构过大或过深，已停止。");
    all.push(node);
    const nested = [...children(node)];
    if ("content" in node && tag(node) === "template") nested.push(node.content);
    for (let i = nested.length - 1; i >= 0; i--) pending.push([nested[i], depth + 1]);
  }
  const titleNode = all.find((n) => tag(n) === "title");
  const title = titleNode
    ? children(titleNode)
        .filter((n) => n.nodeName === "#text")
        .map((n) => ("value" in n ? n.value : ""))
        .join("")
        .trim()
        .slice(0, 512)
    : "";
  const author = attr(all.find((n) => tag(n) === "meta" && attr(n, "name").toLowerCase() === "author") ?? root, "content").slice(0, 512);
  let source = attr(all.find((n) => tag(n) === "link" && attr(n, "rel").toLowerCase().split(/\s+/).includes("canonical")) ?? root, "href");
  if (!/^https?:\/\//i.test(source) || source.length > 2048) source = "";
  // Do not select content under a hidden/blocked ancestor, including template content.
  const visible: Node[] = [];
  const visit: Node[] = [all.find((n) => tag(n) === "body") ?? root];
  while (visit.length) {
    const node = visit.pop()!;
    if (blocked.has(tag(node)) || hidden(node)) continue;
    visible.push(node);
    const nested = children(node);
    for (let i = nested.length - 1; i >= 0; i--) visit.push(nested[i]);
  }
  const selected = visible.find((n) => tag(n) === "article") ?? visible.find((n) => tag(n) === "main") ?? visible[0];
  if (!selected) throw new Error("未找到可提取文字，原件尚未上传。");
  const output: string[] = [];
  const stack: Array<Node | string> = [selected];
  let size = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (typeof current === "string") {
      output.push(current);
      continue;
    }
    if (blocked.has(tag(current)) || hidden(current)) continue;
    if (current.nodeName === "#text" && "value" in current) {
      size += current.value.length;
      if (size > 256 * 1024) throw new Error("提取文字过大，已停止，未截断保存。");
      output.push(current.value);
    }
    if (blocks.has(tag(current))) {
      output.push("\n");
      stack.push("\n");
    }
    const nested = children(current);
    for (let i = nested.length - 1; i >= 0; i--) stack.push(nested[i]);
  }
  const text = output
    .join("")
    .split("\n")
    .map((line) => line.replace(/[\t\r ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!text) throw new Error("未找到可提取文字，可能是图片、导航或依赖脚本的网页。原件尚未上传。");
  if (new TextEncoder().encode(text).length > 256 * 1024) throw new Error("提取文字超过 256 KiB，未截断保存。");
  return { title, author, source, text, selection: tag(selected) || "body", nodes: all.length };
}

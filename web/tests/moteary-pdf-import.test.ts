import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deletePDFPlan, preparePDF, previewPDFDeletion, savePDFPlan } from "@/components/MotearyWorkspace/pdfImport";
import { Visibility } from "@/types/proto/api/memo_service_pb";

const rpc = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getUserUsage: vi.fn(),
  getMemo: vi.fn(),
  createMemo: vi.fn(),
  listMemos: vi.fn(),
  deleteMemo: vi.fn(),
  createAttachment: vi.fn(),
  getAttachment: vi.fn(),
  listAttachments: vi.fn(),
  deleteAttachment: vi.fn(),
}));
vi.mock("@/connect", () => ({
  authServiceClient: { getCurrentUser: rpc.getCurrentUser },
  userServiceClient: { getUserUsage: rpc.getUserUsage },
  memoServiceClient: { getMemo: rpc.getMemo, createMemo: rpc.createMemo, listMemos: rpc.listMemos, deleteMemo: rpc.deleteMemo },
  attachmentServiceClient: {
    createAttachment: rpc.createAttachment,
    getAttachment: rpc.getAttachment,
    listAttachments: rpc.listAttachments,
    deleteAttachment: rpc.deleteAttachment,
  },
}));
vi.mock("@/auth-state", () => ({ getAccessToken: () => null }));
const bytes = new TextEncoder().encode("%PDF-synthetic unit fixture");
const file = (data: Uint8Array = bytes, name = "synthetic.pdf") =>
  ({ name, size: data.length, arrayBuffer: async () => new Uint8Array(data).buffer }) as File;
const hash = async (data: Uint8Array) => Buffer.from(await webcrypto.subtle.digest("SHA-256", new Uint8Array(data))).toString("hex");
const signal = () => new AbortController().signal;
const fetchMock = vi.fn();
const nativeFetch = globalThis.fetch.bind(globalThis);

beforeEach(async () => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", fetchMock);
  for (const mock of Object.values(rpc)) mock.mockReset();
  rpc.getCurrentUser.mockResolvedValue({ user: { name: "users/synthetic" } });
  rpc.getUserUsage.mockResolvedValue({ limits: { memoContentBytes: 8192n } });
  rpc.getMemo.mockRejectedValue(new ConnectError("missing", Code.NotFound));
  rpc.listMemos.mockResolvedValue({ memos: [], nextPageToken: "" });
  rpc.listAttachments.mockResolvedValue({ attachments: [], nextPageToken: "" });
  rpc.createAttachment.mockResolvedValue({ name: "attachments/synthetic" });
  rpc.createMemo.mockImplementation(async ({ memoId }) => ({ name: `memos/${memoId}` }));
  fetchMock.mockReset().mockResolvedValue(
    new Response(
      JSON.stringify({
        parser: "pypdf",
        version: "7.1.1",
        sha256: await hash(bytes),
        pages: [
          { page: 1, text: "中文正文检索" },
          { page: 2, text: "" },
        ],
      }),
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("PDF workflow safety", () => {
  it("previews original bytes and page text without creating records or uploads", async () => {
    const plan = await preparePDF(file(), "work", "users/synthetic", signal());
    expect(plan.records).toHaveLength(2);
    expect(Array.from(plan.records[0].data)).toEqual(Array.from(bytes));
    expect(plan.records[0].content).toContain("第 2 页：无可提取文字");
    expect(plan.records[1].content).toContain(plan.rootName);
    expect(plan.records[1].content).toContain("第 1 页");
    expect(rpc.createAttachment).not.toHaveBeenCalled();
    expect(rpc.createMemo).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST", redirect: "error", cache: "no-store" });
  });
  it("rejects bad hash, unknown parser, and disordered pages before writes", async () => {
    for (const override of [{ sha256: "bad" }, { version: "6.21.4" }, { pages: [{ page: 2, text: "x" }] }]) {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ parser: "pypdf", version: "7.1.1", sha256: await hash(bytes), pages: [{ page: 1, text: "x" }], ...override }),
        ),
      );
      await expect(preparePDF(file(), "work", "users/synthetic", signal())).rejects.toThrow();
    }
    expect(rpc.createAttachment).not.toHaveBeenCalled();
  });
  it("reports unavailable and no-text without claiming OCR", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }));
    await expect(preparePDF(file(), "work", "users/synthetic", signal())).rejects.toThrow("尚未启用");
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "no_text" }), { status: 422 }));
    await expect(preparePDF(file(), "work", "users/synthetic", signal())).rejects.toThrow("未启用 OCR");
  });
  it("keeps extracted markup inert inside a longer code fence", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          parser: "pypdf",
          version: "7.1.1",
          sha256: await hash(bytes),
          pages: [{ page: 1, text: "```\n![image](https://invalid.example/x)\n<script>x</script>" }],
        }),
      ),
    );
    const plan = await preparePDF(file(), "diary", "users/synthetic", signal());
    expect(plan.records[1].content).toContain("````\n```\n![image]");
  });
  it("stops on account changes and records an uncertain uploaded attachment", async () => {
    const plan = await preparePDF(file(), "work", "users/synthetic", signal());
    rpc.getCurrentUser.mockResolvedValueOnce({ user: { name: "users/other" } });
    await expect(savePDFPlan(plan, signal(), vi.fn())).rejects.toThrow("账户已变化");
    expect(rpc.createAttachment).not.toHaveBeenCalled();
    rpc.createMemo.mockRejectedValueOnce(new ConnectError("synthetic failure", Code.Internal));
    await expect(savePDFPlan(plan, signal(), vi.fn())).rejects.toThrow("attachments/synthetic");
    expect(rpc.deleteAttachment).not.toHaveBeenCalled();
  });
  it("rejects edited records rather than overwriting or deleting them", async () => {
    const plan = await preparePDF(file(), "work", "users/synthetic", signal());
    rpc.getMemo.mockResolvedValue({
      name: plan.rootName,
      creator: "users/synthetic",
      visibility: Visibility.PRIVATE,
      content: "edited",
      attachments: [],
    });
    await expect(savePDFPlan(plan, signal(), vi.fn())).rejects.toThrow("已变化");
    await expect(deletePDFPlan(plan, signal(), vi.fn(), { rootName: plan.rootName, orphanAttachments: [] })).rejects.toThrow("已变化");
    expect(rpc.deleteMemo).not.toHaveBeenCalled();
  });
  it("honors already-cancelled work without starting uploads", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(preparePDF(file(), "work", "users/synthetic", controller.signal)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rpc.createAttachment).not.toHaveBeenCalled();
  });
});

const config = process.env.YOUJI_PDF_WEB_QA ? JSON.parse(process.env.YOUJI_PDF_WEB_QA) : undefined;
it.skipIf(!config)(
  "runs the actual web PDF module against real parser/SQLite/HTTP with orphan recovery and cleanup",
  async () => {
    // The harness supplies fresh synthetic accounts. No browser DOM or fake parser.
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await nativeFetch(`${config.base}/api/${path}`, {
        method,
        headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) throw new ConnectError(`HTTP ${response.status}`, response.status === 404 ? Code.NotFound : Code.Internal);
      return response.json();
    };
    fetchMock.mockImplementation((url: string, options: RequestInit = {}) =>
      nativeFetch(`${config.base}${url}`, { ...options, headers: { ...options.headers, Authorization: `Bearer ${config.token}` } }),
    );
    const memo = (value: Record<string, unknown>) => ({
      ...value,
      visibility: value.visibility === "PRIVATE" ? Visibility.PRIVATE : Visibility.PUBLIC,
      attachments: value.attachments ?? [],
    });
    rpc.getCurrentUser.mockImplementation(() => call("GET", "auth/me"));
    rpc.getUserUsage.mockImplementation(async ({ name }) => {
      const result = await call("GET", name);
      result.limits.memoContentBytes = BigInt(result.limits.memoContentBytes ?? 0);
      return result;
    });
    rpc.getMemo.mockImplementation(async ({ name }) => memo(await call("GET", name)));
    rpc.listMemos.mockImplementation(async (args) => {
      const result = await call("GET", `memos?${new URLSearchParams(args)}`);
      return { memos: (result.memos ?? []).map(memo), nextPageToken: result.nextPageToken ?? "" };
    });
    const createMemo = async ({ memoId, memo: value }: { memoId: string; memo: Record<string, unknown> }) =>
      memo(await call("POST", `memos?memoId=${memoId}`, { ...value, visibility: "PRIVATE" }));
    rpc.createMemo.mockImplementation(createMemo);
    rpc.deleteMemo.mockImplementation(({ name }) => call("DELETE", name));
    rpc.createAttachment.mockImplementation(({ attachment }) =>
      call("POST", "attachments", { ...attachment, content: Buffer.from(attachment.content).toString("base64") }),
    );
    rpc.getAttachment.mockImplementation(({ name }) => call("GET", name));
    rpc.listAttachments.mockImplementation(async (args) => {
      const result = await call("GET", `attachments?${new URLSearchParams(args)}`);
      return { attachments: result.attachments ?? [], nextPageToken: result.nextPageToken ?? "" };
    });
    rpc.deleteAttachment.mockImplementation(({ name }) => call("DELETE", name));
    const original = new Uint8Array(readFileSync(config.fixture));
    const plan = await preparePDF(file(original, "合成资料.pdf"), "work", config.owner, signal());
    expect(plan.pages[0].text).toContain("中文检索水杉");
    const baseline = (await call("GET", "attachments?pageSize=100")).attachments?.length ?? 0;
    const emptyPreview = await previewPDFDeletion(plan, signal());
    rpc.createMemo.mockRejectedValueOnce(new ConnectError("injected memo failure after real attachment upload", Code.Internal));
    await expect(savePDFPlan(plan, signal(), vi.fn())).rejects.toThrow("已获回执附件");
    const deletionPreview = await previewPDFDeletion(plan, signal());
    expect(deletionPreview.present).toBe(0);
    expect(deletionPreview.orphanAttachments).toHaveLength(1);
    await expect(deletePDFPlan(plan, signal(), vi.fn(), emptyPreview)).rejects.toThrow("范围发生变化");
    await savePDFPlan(plan, signal(), vi.fn());
    expect((await call("GET", "attachments?pageSize=100")).attachments.length - baseline).toBe(plan.records.length);
    await expect(deletePDFPlan(plan, signal(), vi.fn(), deletionPreview)).rejects.toThrow("范围发生变化");
    const states: string[] = [];
    await savePDFPlan(plan, signal(), (_name, status) => states.push(status));
    expect(states).toEqual(plan.records.map(() => "verified"));
    const rootMemo = await call("GET", plan.rootName);
    for (const credential of [config.otherToken, null]) {
      const headers: Record<string, string> = credential ? { Authorization: `Bearer ${credential}` } : {};
      const deniedMemo = await nativeFetch(`${config.base}/api/${plan.rootName}`, { headers });
      expect([401, 403, 404]).toContain(deniedMemo.status);
      const originalAttachment = rootMemo.attachments[0];
      const deniedOriginal = await nativeFetch(
        `${config.base}/file/${originalAttachment.name}/${encodeURIComponent(originalAttachment.filename)}`,
        { headers },
      );
      expect([401, 403, 404]).toContain(deniedOriginal.status);
    }

    const query = `creator == ${JSON.stringify(config.owner)} && content.contains("中文检索水杉")`;
    expect((await call("GET", `memos?${new URLSearchParams({ filter: query })}`)).memos).toHaveLength(1);
    await deletePDFPlan(plan, signal(), vi.fn(), { rootName: plan.rootName, orphanAttachments: [] });
    expect((await call("GET", `memos?${new URLSearchParams({ filter: query })}`)).memos ?? []).toHaveLength(0);
    expect((await call("GET", "attachments?pageSize=100")).attachments?.length ?? 0).toBe(baseline);
    await deletePDFPlan(plan, signal(), vi.fn(), { rootName: plan.rootName, orphanAttachments: [] });
    // Upload response loss: committed orphan is found by owner/name and verified, not uploaded twice.
    const variant = new Uint8Array([...original, ...new TextEncoder().encode("\n% synthetic lost upload response\n")]);
    const lostPlan = await preparePDF(file(variant), "diary", config.owner, signal());
    const uploadNormally = rpc.createAttachment.getMockImplementation();
    rpc.createAttachment.mockImplementationOnce(async (...args) => {
      await uploadNormally?.(...args);
      throw new ConnectError("synthetic response lost after actual attachment commit", Code.Unavailable);
    });
    await expect(savePDFPlan(lostPlan, signal(), vi.fn())).rejects.toThrow();
    expect((await previewPDFDeletion(lostPlan, signal())).orphanAttachments).toHaveLength(1);
    await savePDFPlan(lostPlan, signal(), vi.fn());
    expect((await call("GET", "attachments?pageSize=100")).attachments.length - baseline).toBe(lostPlan.records.length);
    const lostPreview = await previewPDFDeletion(lostPlan, signal());
    await deletePDFPlan(lostPlan, signal(), vi.fn(), lostPreview);
    // Unlinked-only cleanup is explicit, previewed, and leaves no uploaded archive behind.
    rpc.createMemo.mockRejectedValueOnce(new ConnectError("synthetic memo failure", Code.Internal));
    await expect(savePDFPlan(lostPlan, signal(), vi.fn())).rejects.toThrow();
    const orphanOnly = await previewPDFDeletion(lostPlan, signal());
    expect(orphanOnly.present).toBe(0);
    expect(orphanOnly.orphanAttachments).toHaveLength(1);
    await deletePDFPlan(lostPlan, signal(), vi.fn(), orphanOnly);
    expect((await call("GET", "attachments?pageSize=100")).attachments?.length ?? 0).toBe(baseline);
  },
  60_000,
);

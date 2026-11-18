import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PDFImport from "@/components/MotearyWorkspace/PDFImport";

const api = vi.hoisted(() => ({ preparePDF: vi.fn(), savePDFPlan: vi.fn(), previewPDFDeletion: vi.fn(), deletePDFPlan: vi.fn() }));
vi.mock("@/components/MotearyWorkspace/pdfImport", () => api);
const plan = {
  filename: "synthetic.pdf",
  sha256: "a".repeat(64),
  rootName: "memos/root",
  records: [{}, {}],
  pages: [
    { page: 1, text: "<img src=x onerror=alert(1)>" },
    { page: 2, text: "" },
  ],
};
const onSaved = vi.fn();
const mount = () =>
  render(
    <MemoryRouter>
      <PDFImport userName="users/alice" onSaved={onSaved} />
    </MemoryRouter>,
  );
const preview = async () => {
  fireEvent.change(screen.getByLabelText("PDF 文件"), {
    target: { files: [new File(["synthetic"], "synthetic.pdf", { type: "application/pdf" })] },
  });
  fireEvent.click(screen.getByRole("button", { name: "本地解析并预览" }));
  await screen.findByRole("button", { name: "保存原件与可检索正文" });
};
describe("PDF import UI boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.preparePDF.mockReset().mockResolvedValue(plan);
    api.savePDFPlan.mockReset().mockResolvedValue(undefined);
    api.previewPDFDeletion
      .mockReset()
      .mockResolvedValue({ rootName: "memos/root", present: 2, planned: 2, orphanAttachments: ["attachments/orphan"] });
    api.deletePDFPlan.mockReset().mockResolvedValue(undefined);
  });
  afterEach(cleanup);
  it("requires explicit parsing, presents page text safely and does not save during preview", async () => {
    mount();
    expect(api.preparePDF).not.toHaveBeenCalled();
    await preview();
    expect(screen.getByText("第 2 页 · 无可提取文字")).toBeInTheDocument();
    expect(screen.getByText("<img src=x onerror=alert(1)>").tagName).toBe("PRE");
    expect(document.querySelector("img")).toBeNull();
    expect(api.savePDFPlan).not.toHaveBeenCalled();
    expect(api.preparePDF.mock.calls[0].slice(1, 3)).toEqual(["reference", "users/alice"]);
  });
  it("reports verified duplicates separately and only completes when every save finishes", async () => {
    let finish: (() => void) | undefined;
    api.savePDFPlan.mockImplementation((_plan, _signal, callback) => {
      callback("memos/root", "verified");
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    mount();
    await preview();
    fireEvent.click(screen.getByRole("button", { name: "保存原件与可检索正文" }));
    expect(screen.getByText(/已核验已有记录/)).toBeInTheDocument();
    expect(screen.queryByText(/原件与可检索正文已全部保存/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("PDF 文件")).toBeDisabled();
    finish?.();
    await screen.findByText(/原件与可检索正文已全部保存/);
  });
  it("preserves a failed plan for retry and suppresses late success after cancellation", async () => {
    api.savePDFPlan.mockRejectedValueOnce(new Error("temporary failure"));
    const view = mount();
    await preview();
    fireEvent.click(screen.getByRole("button", { name: "保存原件与可检索正文" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("保存未完成");
    let finish: (() => void) | undefined;
    api.savePDFPlan.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存原件与可检索正文" }));
    const signal = api.savePDFPlan.mock.calls[1][1];
    fireEvent.click(screen.getByRole("button", { name: "取消保存" }));
    expect(signal.aborted).toBe(true);
    finish?.();
    await waitFor(() => expect(screen.queryByText(/原件与可检索正文已全部保存/)).not.toBeInTheDocument());
    expect(screen.getByText(/保存或清理可能已有部分生效/)).toBeInTheDocument();
    view.unmount();
  });
  it("requires a fresh scope check and explicit confirmation before irreversible cleanup", async () => {
    mount();
    await preview();
    fireEvent.click(screen.getByRole("button", { name: "检查这份导入的清理范围" }));
    const remove = await screen.findByRole("button", { name: "确认删除这份导入" });
    expect(remove).toBeDisabled();
    expect(screen.getByText("attachments/orphan")).toBeInTheDocument();
    expect(screen.getByText(/含归档和嵌套评论/)).toBeInTheDocument();
    expect(api.deletePDFPlan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: "我已核对范围并确认不可撤销删除" }));
    fireEvent.click(remove);
    await screen.findByText(/这份导入的清理已完成/);
    expect(api.deletePDFPlan).toHaveBeenCalledOnce();
    expect(api.deletePDFPlan.mock.calls[0][3]).toEqual({
      rootName: "memos/root",
      present: 2,
      planned: 2,
      orphanAttachments: ["attachments/orphan"],
    });
    expect(screen.queryByRole("button", { name: "确认删除这份导入" })).not.toBeInTheDocument();
  });
  it("aborts on unmount and ignores late record callbacks", async () => {
    let callback: ((name: string, status: string) => void) | undefined;
    let finish: (() => void) | undefined;
    api.savePDFPlan.mockImplementation((_plan, _signal, record) => {
      callback = record;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const view = mount();
    await preview();
    fireEvent.click(screen.getByRole("button", { name: "保存原件与可检索正文" }));
    view.unmount();
    expect(api.savePDFPlan.mock.calls[0][1].aborted).toBe(true);
    callback?.("memos/late", "imported");
    finish?.();
    await Promise.resolve();
    expect(onSaved).not.toHaveBeenCalled();
  });
  it("rejects oversized files before sending and explains an unavailable parser without saving", async () => {
    mount();
    const file = new File(["synthetic"], "synthetic.pdf");
    Object.defineProperty(file, "size", { value: 16 * 1024 * 1024 + 1 });
    fireEvent.change(screen.getByLabelText("PDF 文件"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "本地解析并预览" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("不能超过 16 MiB");
    expect(api.preparePDF).not.toHaveBeenCalled();
    api.preparePDF.mockRejectedValueOnce(new Error("本地解析服务不可用"));
    fireEvent.change(screen.getByLabelText("PDF 文件"), { target: { files: [new File(["synthetic"], "synthetic.pdf")] } });
    fireEvent.click(screen.getByRole("button", { name: "本地解析并预览" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("本地解析服务不可用");
    expect(screen.getByText(/音频 \/ 文档.*普通上传/)).toBeInTheDocument();
    expect(api.savePDFPlan).not.toHaveBeenCalled();
  });
  it("requires scope inspection again after a partial cleanup failure", async () => {
    api.deletePDFPlan.mockRejectedValueOnce(new Error("delete interrupted"));
    mount();
    await preview();
    fireEvent.click(screen.getByRole("button", { name: "检查这份导入的清理范围" }));
    await screen.findByRole("button", { name: "确认删除这份导入" });
    fireEvent.click(screen.getByRole("checkbox", { name: "我已核对范围并确认不可撤销删除" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除这份导入" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("清理未完成");
    expect(screen.queryByText(/这份导入的清理已完成/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认删除这份导入" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "检查这份导入的清理范围" }));
    expect(await screen.findByRole("button", { name: "确认删除这份导入" })).toBeDisabled();
  });
  it("does not let a cancelled parse unlock or replace a newer pending parse", async () => {
    let finishFirst: ((value: typeof plan) => void) | undefined;
    let finishSecond: ((value: typeof plan) => void) | undefined;
    api.preparePDF.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        }),
    );
    api.preparePDF.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSecond = resolve;
        }),
    );
    mount();
    fireEvent.change(screen.getByLabelText("PDF 文件"), { target: { files: [new File(["synthetic"], "synthetic.pdf")] } });
    fireEvent.click(screen.getByRole("button", { name: "本地解析并预览" }));
    fireEvent.click(screen.getByRole("button", { name: "取消解析" }));
    expect(api.preparePDF.mock.calls[0][3].aborted).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "本地解析并预览" }));
    finishFirst?.({ ...plan, filename: "stale.pdf" });
    await waitFor(() => expect(screen.getByRole("button", { name: "本地解析并预览" })).toBeDisabled());
    expect(screen.queryByText(/stale.pdf/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存原件与可检索正文" })).not.toBeInTheDocument();
    finishSecond?.(plan);
    await screen.findByRole("button", { name: "保存原件与可检索正文" });
    expect(screen.getByRole("button", { name: "本地解析并预览" })).toBeEnabled();
  });
});

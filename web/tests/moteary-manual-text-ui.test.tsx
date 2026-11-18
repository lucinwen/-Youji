import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ManualTextImport from "@/components/MotearyWorkspace/ManualTextImport";

const api = vi.hoisted(() => ({ prepareManualText: vi.fn(), preparePastedText: vi.fn(), saveManualText: vi.fn() }));
vi.mock("@/components/MotearyWorkspace/manualTextImport", () => ({
  ...api,
  SOURCES: {
    unspecified: "未注明来源",
    wechat: "微信聊天（手动提供）",
    friends: "朋友对话（手动提供）",
    lecture: "讲座或录音人工稿",
    podcast: "播客人工稿",
    diary: "生活日记",
    work: "工作思考",
    idea: "快速灵感",
  },
}));
const plan = {
  item: { id: "mwt-synthetic", owner: "users/test" },
  text: "<img src=x onerror=alert(1)> https://example.invalid/",
  title: "合成文字",
  source: "unspecified",
};
const receipt = { memo: "memos/mwt-synthetic", status: "imported", attachment: "attachments/synthetic" };
const saved = vi.fn();
const element = (userName = "users/test") => (
  <MemoryRouter>
    <ManualTextImport userName={userName} onSaved={saved} />
  </MemoryRouter>
);
const mount = () => render(element());
const paste = () => fireEvent.change(screen.getByLabelText("待导入文字"), { target: { value: plan.text } });
const preview = async () => {
  paste();
  fireEvent.click(screen.getByRole("button", { name: "本地预览文字" }));
  await screen.findByLabelText("手动文本预览");
};
const save = () => {
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "保存文本原件与正文" }));
};
beforeEach(() => {
  vi.clearAllMocks();
  api.prepareManualText.mockReset().mockResolvedValue(plan);
  api.preparePastedText.mockReset().mockResolvedValue(plan);
  api.saveManualText.mockReset().mockResolvedValue(receipt);
});
afterEach(cleanup);

describe("Manual text import UI", () => {
  it("requires explicit local preview then confirmation to save pasted plain text", async () => {
    mount();
    expect(screen.getByText(/128 KiB.*刷新后未保存内容会丢失/)).toBeInTheDocument();
    expect(screen.getByLabelText("文本标题")).toHaveAttribute("maxlength", "200");
    expect(screen.getByRole("button", { name: "本地预览文字" })).toBeDisabled();
    paste();
    expect(api.preparePastedText).not.toHaveBeenCalled();
    expect(api.saveManualText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "本地预览文字" }));
    await screen.findByLabelText("手动文本预览");
    expect(api.preparePastedText).toHaveBeenCalledWith(plan.text, "users/test", { source: "unspecified", title: "" });
    expect(document.querySelector("img")).toBeNull();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存文本原件与正文" })).toBeDisabled();
    save();
    await screen.findByText(/已仅自己可见保存/);
    expect(api.saveManualText).toHaveBeenCalledWith(plan, expect.any(AbortSignal), expect.any(Function));
    expect(saved).toHaveBeenCalledOnce();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/memos/mwt-synthetic");
  });
  it("previews a chosen text file only after the explicit button, with selected title and source", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "选择文本文件" }));
    const file = new File(["合成笔记"], "synthetic.md", { type: "text/markdown" });
    fireEvent.change(screen.getByLabelText("文本原件"), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText("文本标题"), { target: { value: "合成标题" } });
    fireEvent.change(screen.getByLabelText("文本来源"), { target: { value: "work" } });
    expect(api.prepareManualText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "本地预览文字" }));
    await screen.findByLabelText("手动文本预览");
    expect(api.prepareManualText).toHaveBeenCalledWith(file, "users/test", { source: "work", title: "合成标题" });
    expect(api.preparePastedText).not.toHaveBeenCalled();
    expect(api.saveManualText).not.toHaveBeenCalled();
  });
  it.each(["text", "title", "source", "mode"])("invalidates preview and confirmation when %s changes", async (field) => {
    mount();
    await preview();
    fireEvent.click(screen.getByRole("checkbox"));
    if (field === "text") fireEvent.change(screen.getByLabelText("待导入文字"), { target: { value: "changed" } });
    else if (field === "title") fireEvent.change(screen.getByLabelText("文本标题"), { target: { value: "changed" } });
    else if (field === "source") fireEvent.change(screen.getByLabelText("文本来源"), { target: { value: "diary" } });
    else fireEvent.click(screen.getByRole("button", { name: "选择文本文件" }));
    expect(screen.queryByLabelText("手动文本预览")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(api.saveManualText).not.toHaveBeenCalled();
    if (field !== "mode") {
      fireEvent.click(screen.getByRole("button", { name: "本地预览文字" }));
      await screen.findByLabelText("手动文本预览");
      expect(screen.getByRole("checkbox")).not.toBeChecked();
    }
  });
  it("keeps failure receipts and the plan for retry, without clearing receipts when inputs change", async () => {
    api.saveManualText
      .mockImplementationOnce(async (_plan, _signal, callback) => {
        callback({ ...receipt, status: "save-unknown" });
        throw new Error("写入结果未知");
      })
      .mockResolvedValueOnce({ ...receipt, status: "verified" });
    mount();
    await preview();
    save();
    await screen.findByText("写入结果未知");
    expect(screen.getByLabelText("手动文本预览")).toBeInTheDocument();
    expect(screen.getByText(/恢复回执：save-unknown/)).toBeInTheDocument();
    expect(saved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存文本原件与正文" }));
    await screen.findByText("已有原件与正文已核验，未重复创建。");
    expect(saved).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText("文本标题"), { target: { value: "new title" } });
    expect(screen.queryByLabelText("手动文本预览")).not.toBeInTheDocument();
    expect(screen.getByText(/恢复回执：verified/)).toBeInTheDocument();
  });
  it("shows preview errors without exposing a save action", async () => {
    api.preparePastedText.mockRejectedValueOnce(new Error("文本超过大小限制"));
    mount();
    paste();
    fireEvent.click(screen.getByRole("button", { name: "本地预览文字" }));
    await screen.findByText("文本超过大小限制");
    expect(screen.queryByRole("button", { name: "保存文本原件与正文" })).not.toBeInTheDocument();
    expect(api.saveManualText).not.toHaveBeenCalled();
  });
  it.each(["cancel", "account", "unmount"])("ignores a late local preview after %s", async (reason) => {
    let finish: ((value: typeof plan) => void) | undefined;
    api.preparePastedText.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = mount();
    paste();
    fireEvent.click(screen.getByRole("button", { name: "本地预览文字" }));
    if (reason === "cancel") fireEvent.click(screen.getByRole("button", { name: "停止等待" }));
    else if (reason === "account") view.rerender(element("users/other"));
    else view.unmount();
    await act(async () => {
      finish?.(plan);
    });
    expect(screen.queryByLabelText("手动文本预览")).not.toBeInTheDocument();
    expect(api.saveManualText).not.toHaveBeenCalled();
    if (reason === "account") expect(screen.getByLabelText("待导入文字")).toHaveValue("");
  });
  it.each(["cancel", "account", "unmount"])("ignores late save callbacks after %s", async (reason) => {
    let finish: ((value: typeof receipt) => void) | undefined;
    let callback: ((value: typeof receipt) => void) | undefined;
    api.saveManualText.mockImplementationOnce((_plan, _signal, update) => {
      callback = update;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const view = mount();
    await preview();
    save();
    await waitFor(() => expect(api.saveManualText).toHaveBeenCalledOnce());
    const signal = api.saveManualText.mock.calls[0][1];
    if (reason === "cancel") fireEvent.click(screen.getByRole("button", { name: "停止等待" }));
    else if (reason === "account") view.rerender(element("users/other"));
    else view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => {
      callback?.(receipt);
      finish?.(receipt);
    });
    expect(screen.queryByText(/恢复回执/)).not.toBeInTheDocument();
    expect(saved).not.toHaveBeenCalled();
    if (reason === "cancel") expect(screen.getByRole("status")).toHaveTextContent("已提交写入不保证撤销");
  });
});

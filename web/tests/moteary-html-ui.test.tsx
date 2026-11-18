import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HTMLImport from "@/components/MotearyWorkspace/HTMLImport";

const api = vi.hoisted(() => ({ prepareHTML: vi.fn(), saveHTML: vi.fn() }));
vi.mock("@/components/MotearyWorkspace/htmlImport", () => api);
const plan = {
  item: { id: "mwh-synthetic", owner: "users/test" },
  parsed: {
    title: "合成网页",
    text: "<img src=x onerror=alert(1)> https://example.invalid/",
    source: "https://example.invalid/source",
    author: "合成作者",
    selection: "article",
    nodes: 20,
  },
};
const receipt = { memo: "memos/mwh-synthetic", status: "imported", attachment: "attachments/original" };
const onSaved = vi.fn();
const mount = () =>
  render(
    <MemoryRouter>
      <HTMLImport userName="users/test" onSaved={onSaved} />
    </MemoryRouter>,
  );
const select = () =>
  fireEvent.change(screen.getByLabelText("本地 HTML 原件"), { target: { files: [new File(["synthetic"], "synthetic.html")] } });
const preview = async () => {
  select();
  await screen.findByLabelText("网页文字预览");
};
const save = () => {
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "保存网页原件与文字" }));
};
beforeEach(() => {
  vi.clearAllMocks();
  api.prepareHTML.mockReset().mockResolvedValue(plan);
  api.saveHTML.mockReset().mockResolvedValue(receipt);
});
afterEach(cleanup);
describe("Explicit HTML import UI", () => {
  it("previews text and media limits without saving, then requires confirmation", async () => {
    mount();
    expect(api.prepareHTML).not.toHaveBeenCalled();
    await preview();
    expect(api.prepareHTML).toHaveBeenCalledWith(expect.any(File), "users/test", expect.any(AbortSignal));
    expect(screen.getByLabelText("网页文字预览")).toHaveTextContent(plan.parsed.text);
    expect(document.querySelector("img")).toBeNull();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText(/来源（仅文字）：https:\/\/example.invalid\/source/)).toBeInTheDocument();
    expect(api.saveHTML).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "保存网页原件与文字" })).toBeDisabled();
    save();
    await screen.findByText(/已仅自己可见保存/);
    expect(api.saveHTML).toHaveBeenCalledWith(plan, expect.any(AbortSignal), expect.any(Function));
    expect(onSaved).toHaveBeenCalledOnce();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/memos/mwh-synthetic");
  });
  it("preserves the failed plan and upload receipt for explicit retry", async () => {
    api.saveHTML
      .mockImplementationOnce(async (_plan, _signal, callback) => {
        callback({ ...receipt, status: "save-unknown" });
        throw new Error("写入状态未知，请重试");
      })
      .mockResolvedValueOnce({ ...receipt, status: "verified" });
    mount();
    await preview();
    save();
    await screen.findByText("写入状态未知，请重试");
    expect(screen.getByLabelText("网页文字预览")).toHaveTextContent(plan.parsed.text);
    expect(screen.getByText(/恢复回执：save-unknown/)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存网页原件与文字" }));
    await screen.findByText("已有原件与正文已核验，未重复创建。");
    expect(api.saveHTML).toHaveBeenCalledTimes(2);
    expect(onSaved).toHaveBeenCalledOnce();
  });
  it("clears prior confirmation when a new file is previewed and leaves invalid input unsaved", async () => {
    mount();
    await preview();
    fireEvent.click(screen.getByRole("checkbox"));
    api.prepareHTML.mockRejectedValueOnce(new Error("不是有效HTML"));
    select();
    await screen.findByText("不是有效HTML");
    expect(screen.queryByRole("button", { name: "保存网页原件与文字" })).not.toBeInTheDocument();
    await preview();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(api.saveHTML).not.toHaveBeenCalled();
  });
  it.each(["cancel", "unmount", "account"])("does not restore a late preview after %s", async (reason) => {
    let finish: ((value: typeof plan) => void) | undefined;
    api.prepareHTML.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = mount();
    select();
    if (reason === "cancel") fireEvent.click(screen.getByRole("button", { name: "停止等待" }));
    else if (reason === "account")
      view.rerender(
        <MemoryRouter>
          <HTMLImport userName="users/other" onSaved={onSaved} />
        </MemoryRouter>,
      );
    else view.unmount();
    await act(async () => {
      finish?.(plan);
    });
    expect(screen.queryByLabelText("网页文字预览")).not.toBeInTheDocument();
    expect(api.saveHTML).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });
  it.each(["cancel", "unmount", "account"])("ignores late save receipts and completion after %s", async (reason) => {
    let finish: ((value: typeof receipt) => void) | undefined;
    let callback: ((value: typeof receipt) => void) | undefined;
    api.saveHTML.mockImplementationOnce((_plan, _signal, update) => {
      callback = update;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const view = mount();
    await preview();
    save();
    await waitFor(() => expect(api.saveHTML).toHaveBeenCalledOnce());
    const signal = api.saveHTML.mock.calls[0][1];
    if (reason === "cancel") fireEvent.click(screen.getByRole("button", { name: "停止等待" }));
    else if (reason === "account")
      view.rerender(
        <MemoryRouter>
          <HTMLImport userName="users/other" onSaved={onSaved} />
        </MemoryRouter>,
      );
    else view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => {
      callback?.(receipt);
      finish?.(receipt);
    });
    expect(screen.queryByText(/恢复回执/)).not.toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    if (reason === "cancel") expect(screen.getByRole("status")).toHaveTextContent("已提交写入不保证撤销");
  });
  it("clears an existing plan, confirmation and save receipt on account changes", async () => {
    const view = mount();
    await preview();
    save();
    await screen.findByText(/已仅自己可见保存/);
    view.rerender(
      <MemoryRouter>
        <HTMLImport userName="users/other" onSaved={onSaved} />
      </MemoryRouter>,
    );
    expect(screen.queryByLabelText("网页文字预览")).not.toBeInTheDocument();
    expect(screen.queryByText(/恢复回执/)).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByLabelText("本地 HTML 原件")).toBeEnabled();
  });
});

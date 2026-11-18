import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatImport from "@/components/MotearyWorkspace/ChatImport";

const api = vi.hoisted(() => ({ prepareChat: vi.fn(), saveChat: vi.fn() }));
vi.mock("@/components/MotearyWorkspace/chatImport", () => api);
const plan = {
  item: { id: "mwc-synthetic", owner: "users/test" },
  title: "合成聊天",
  transcript: "<img src=x onerror=alert(1)> https://example.invalid/",
  messages: 2,
  service: 1,
  media: 1,
};
const receipt = { memo: "memos/mwc-synthetic", status: "imported", attachment: "attachments/original" };
const onSaved = vi.fn();
const mount = () =>
  render(
    <MemoryRouter>
      <ChatImport userName="users/test" onSaved={onSaved} />
    </MemoryRouter>,
  );
const select = () =>
  fireEvent.change(screen.getByLabelText("聊天 JSON 原件"), { target: { files: [new File(["synthetic"], "chat.json")] } });
const preview = async () => {
  select();
  await screen.findByLabelText("聊天正文预览");
};
const save = () => {
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "保存聊天原件与正文" }));
};
beforeEach(() => {
  vi.clearAllMocks();
  api.prepareChat.mockReset().mockResolvedValue(plan);
  api.saveChat.mockReset().mockResolvedValue(receipt);
});
afterEach(cleanup);
describe("Explicit chat import UI", () => {
  it("previews text and media limits without saving, then requires confirmation", async () => {
    mount();
    expect(api.prepareChat).not.toHaveBeenCalled();
    await preview();
    expect(api.prepareChat).toHaveBeenCalledWith(expect.any(File), "users/test");
    expect(screen.getByLabelText("聊天正文预览")).toHaveTextContent(plan.transcript);
    expect(document.querySelector("img")).toBeNull();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText(/1 条服务事件仅保留在原件/)).toBeInTheDocument();
    expect(api.saveChat).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "保存聊天原件与正文" })).toBeDisabled();
    save();
    await screen.findByText(/已仅自己可见保存/);
    expect(api.saveChat).toHaveBeenCalledWith(plan, expect.any(AbortSignal), expect.any(Function));
    expect(onSaved).toHaveBeenCalledOnce();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/memos/mwc-synthetic");
  });
  it("preserves the failed plan and upload receipt for explicit retry", async () => {
    api.saveChat
      .mockImplementationOnce(async (_plan, _signal, callback) => {
        callback({ ...receipt, status: "save-unknown" });
        throw new Error("写入状态未知，请重试");
      })
      .mockResolvedValueOnce({ ...receipt, status: "verified" });
    mount();
    await preview();
    save();
    await screen.findByText("写入状态未知，请重试");
    expect(screen.getByLabelText("聊天正文预览")).toHaveTextContent(plan.transcript);
    expect(screen.getByText(/恢复回执：save-unknown/)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存聊天原件与正文" }));
    await screen.findByText("已有原件与正文已核验，未重复创建。");
    expect(api.saveChat).toHaveBeenCalledTimes(2);
    expect(onSaved).toHaveBeenCalledOnce();
  });
  it("clears prior confirmation when a new file is previewed and leaves invalid input unsaved", async () => {
    mount();
    await preview();
    fireEvent.click(screen.getByRole("checkbox"));
    api.prepareChat.mockRejectedValueOnce(new Error("不是有效单聊天"));
    select();
    await screen.findByText("不是有效单聊天");
    expect(screen.queryByRole("button", { name: "保存聊天原件与正文" })).not.toBeInTheDocument();
    await preview();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(api.saveChat).not.toHaveBeenCalled();
  });
  it.each(["cancel", "unmount", "account"])("does not restore a late preview after %s", async (reason) => {
    let finish: ((value: typeof plan) => void) | undefined;
    api.prepareChat.mockImplementationOnce(
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
          <ChatImport userName="users/other" onSaved={onSaved} />
        </MemoryRouter>,
      );
    else view.unmount();
    await act(async () => {
      finish?.(plan);
    });
    expect(screen.queryByLabelText("聊天正文预览")).not.toBeInTheDocument();
    expect(api.saveChat).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });
  it.each(["cancel", "unmount", "account"])("ignores late save receipts and completion after %s", async (reason) => {
    let finish: ((value: typeof receipt) => void) | undefined;
    let callback: ((value: typeof receipt) => void) | undefined;
    api.saveChat.mockImplementationOnce((_plan, _signal, update) => {
      callback = update;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const view = mount();
    await preview();
    save();
    await waitFor(() => expect(api.saveChat).toHaveBeenCalledOnce());
    const signal = api.saveChat.mock.calls[0][1];
    if (reason === "cancel") fireEvent.click(screen.getByRole("button", { name: "停止等待" }));
    else if (reason === "account")
      view.rerender(
        <MemoryRouter>
          <ChatImport userName="users/other" onSaved={onSaved} />
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
        <ChatImport userName="users/other" onSaved={onSaved} />
      </MemoryRouter>,
    );
    expect(screen.queryByLabelText("聊天正文预览")).not.toBeInTheDocument();
    expect(screen.queryByText(/恢复回执/)).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByLabelText("聊天 JSON 原件")).toBeEnabled();
  });
});

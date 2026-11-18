import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ManualTextImport from "@/components/MotearyWorkspace/ManualTextImport";
import { readManualDraft, readManualDraftRaw, writeManualDraft } from "@/components/MotearyWorkspace/manualDraftStore";

import { installManualDraftLocks } from "./helpers/manual-draft-locks";

let locks: ReturnType<typeof installManualDraftLocks>;
const api = vi.hoisted(() => ({ preparePastedText: vi.fn(), prepareManualText: vi.fn(), saveManualText: vi.fn() }));
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
const owner = "users/synthetic";
const other = "users/other";
const input = { text: "合成私人草稿 <img src=x>", title: "合成标题", source: "diary" as const };
const plan = { item: { id: "mwt-synthetic", owner }, text: input.text, title: input.title, source: input.source };
const onSaved = vi.fn();
const element = (userName = owner) => (
  <MemoryRouter>
    <ManualTextImport userName={userName} onSaved={onSaved} />
  </MemoryRouter>
);
const fill = (value = input.text) => fireEvent.change(screen.getByLabelText("待导入文字"), { target: { value } });
const enable = async () => {
  fireEvent.click(screen.getByLabelText("同意本地明文存储风险"));
  fireEvent.click(screen.getByRole("button", { name: "启用本地草稿保存" }));
  await act(async () => {});
};
const restore = () => {
  fireEvent.click(screen.getByLabelText("确认恢复替换当前输入"));
  fireEvent.click(screen.getByRole("button", { name: "恢复本地草稿" }));
};
const save = async () => {
  fireEvent.click(screen.getByRole("button", { name: "本地预览文字" }));
  await screen.findByLabelText("手动文本预览");
  fireEvent.click(screen.getByRole("checkbox", { name: /我已核对内容/ }));
  fireEvent.click(screen.getByRole("button", { name: "保存文本原件与正文" }));
};
beforeEach(() => {
  locks = installManualDraftLocks();
  window.localStorage.clear();
  vi.clearAllMocks();
  api.preparePastedText.mockReset().mockResolvedValue(plan);
  api.prepareManualText.mockReset().mockResolvedValue(plan);
  api.saveManualText.mockReset().mockResolvedValue({ memo: "memos/mwt-synthetic", status: "imported" });
});
afterEach(() => {
  cleanup();
  locks.restore();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("Explicit plaintext local manual drafts", () => {
  it("does not persist or auto-restore by default, even after typing", async () => {
    const set = vi.spyOn(Storage.prototype, "setItem");
    render(element());
    fill();
    expect(set).not.toHaveBeenCalled();
    expect(readManualDraft(owner)).toBeNull();
    expect(screen.getByRole("button", { name: "启用本地草稿保存" })).toBeDisabled();
    expect(screen.getByText(/未加密明文/)).toBeInTheDocument();
    expect(api.saveManualText).not.toHaveBeenCalled();
  });
  it("writes only after risk consent plus enable, and updates exact edited values", async () => {
    render(element());
    fill();
    fireEvent.click(screen.getByLabelText("同意本地明文存储风险"));
    expect(readManualDraft(owner)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "启用本地草稿保存" }));
    await act(async () => {});
    expect(readManualDraft(owner)?.value.text).toBe(input.text);
    fireEvent.change(screen.getByLabelText("文本标题"), { target: { value: input.title } });
    fireEvent.change(screen.getByLabelText("文本来源"), { target: { value: input.source } });
    await act(async () => {});
    expect(readManualDraft(owner)?.value).toEqual(expect.objectContaining(input));
    expect(api.preparePastedText).not.toHaveBeenCalled();
    expect(api.saveManualText).not.toHaveBeenCalled();
  });
  it("retains the draft across remount but requires a confirmed replacement and does not resume autosave", async () => {
    const first = render(element());
    fill();
    await enable();
    const raw = readManualDraftRaw(owner);
    first.unmount();
    render(element());
    expect(screen.getByLabelText("待导入文字")).toHaveValue("");
    expect(screen.getByRole("button", { name: "恢复本地草稿" })).toBeDisabled();
    fill("当前未保存输入");
    restore();
    expect(screen.getByLabelText("待导入文字")).toHaveValue(input.text);
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByLabelText("同意本地明文存储风险")).not.toBeChecked();
    fill("恢复后改动，但未启用自动保存");
    expect(readManualDraftRaw(owner)).toBe(raw);
    expect(api.saveManualText).not.toHaveBeenCalled();
  });
  it("never overwrites an existing unadopted draft when opt-in is requested", async () => {
    const original = await writeManualDraft(owner, input, null);
    render(element());
    fill("新输入");
    await enable();
    expect(screen.getByRole("button", { name: "启用本地草稿保存" })).toBeDisabled();
    expect(readManualDraftRaw(owner)).toBe(original.raw);
  });
  it("requires explicit deletion, then does not recreate the draft from page input", async () => {
    render(element());
    fill();
    await enable();
    expect(screen.getByRole("button", { name: "删除本地草稿并停止保存" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText("确认删除本地草稿"));
    fireEvent.click(screen.getByRole("button", { name: "删除本地草稿并停止保存" }));
    await act(async () => {});
    expect(readManualDraft(owner)).toBeNull();
    expect(screen.getByLabelText("待导入文字")).toHaveValue(input.text);
    fill("删除后继续输入");
    expect(readManualDraft(owner)).toBeNull();
  });
  it.each(["imported", "verified"])("cleans this session's unchanged draft on successful %s and stops persistence", async (status) => {
    api.saveManualText.mockResolvedValue({ memo: "memos/mwt-synthetic", status });
    render(element());
    fill();
    await enable();
    await save();
    await screen.findByText(/本轮新版本地草稿已清除/);
    expect(readManualDraft(owner)).toBeNull();
    fill("成功后新输入");
    expect(readManualDraft(owner)).toBeNull();
  });
  it("cleans an explicitly restored draft after successful save without enabling persistence", async () => {
    await writeManualDraft(owner, input, null);
    render(element());
    restore();
    await save();
    await screen.findByText(/本轮新版本地草稿已清除/);
    expect(readManualDraft(owner)).toBeNull();
  });
  it("keeps both failed drafts and unadopted old drafts rather than silently deleting them", async () => {
    api.saveManualText.mockRejectedValueOnce(new Error("server unavailable"));
    const view = render(element());
    fill();
    await enable();
    await save();
    await screen.findByText("server unavailable");
    const previous = readManualDraftRaw(owner);
    expect(previous).not.toBeNull();
    view.unmount();
    render(element());
    fill("另一条未启用草稿的输入");
    await save();
    await screen.findByText(/已仅自己可见保存/);
    expect(readManualDraftRaw(owner)).toBe(previous);
  });
  it("reports quota failure and stops saving while preserving current input", async () => {
    render(element());
    fill();
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    await enable();
    expect(screen.getByRole("alert")).toHaveTextContent("空间不足");
    const count = set.mock.calls.length;
    fill("仍保留页面输入");
    expect(set).toHaveBeenCalledTimes(count);
    expect(screen.getByLabelText("待导入文字")).toHaveValue("仍保留页面输入");
  });
  it("reports blocked storage access without preventing ordinary text entry", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    render(element());
    fill();
    expect(screen.getByRole("alert")).toHaveTextContent("无法访问本地草稿存储");
    expect(screen.getByRole("button", { name: "启用本地草稿保存" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "本地预览文字" })).toBeEnabled();
  });
  it("offers confirmed deletion of malformed data without displaying its raw secret", async () => {
    const snapshot = await writeManualDraft(owner, input, null);
    const key = window.localStorage.key(0)!;
    window.localStorage.setItem(key, "corrupt-secret-not-for-display");
    expect(snapshot.raw).not.toBeNull();
    render(element());
    expect(screen.getByRole("alert")).toHaveTextContent("草稿损坏");
    expect(screen.queryByText(/corrupt-secret-not-for-display/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "恢复本地草稿" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("确认删除本地草稿"));
    fireEvent.click(screen.getByRole("button", { name: "删除本地草稿并停止保存" }));
    await act(async () => {});
    expect(readManualDraftRaw(owner)).toBeNull();
  });
  it("does not write old account input into the next account during effect transitions", async () => {
    const second = await writeManualDraft(other, { ...input, text: "另一个账号草稿" }, null);
    const view = render(element());
    fill();
    await enable();
    const first = readManualDraftRaw(owner);
    view.rerender(element(other));
    expect(screen.getByLabelText("待导入文字")).toHaveValue("");
    expect(screen.getByLabelText("同意本地明文存储风险")).not.toBeChecked();
    expect(readManualDraftRaw(other)).toBe(second.raw);
    expect(readManualDraftRaw(owner)).toBe(first);
    fill("另账号未启用输入");
    expect(readManualDraftRaw(other)).toBe(second.raw);
  });
  it("stops persistence in file mode and requires opt-in again when returning", async () => {
    render(element());
    fill();
    await enable();
    const original = readManualDraftRaw(owner);
    fireEvent.click(screen.getByRole("button", { name: "选择文本文件" }));
    expect(screen.getByLabelText("同意本地明文存储风险")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("文本标题"), { target: { value: "文件标题" } });
    expect(readManualDraftRaw(owner)).toBe(original);
    fireEvent.click(screen.getByRole("button", { name: "粘贴文字" }));
    fill("回到粘贴模式");
    expect(readManualDraftRaw(owner)).toBe(original);
  });
  it("responds to another tab's storage event by stopping instead of overwriting", async () => {
    render(element());
    fill();
    await enable();
    const foreign = await writeManualDraft(owner, { ...input, text: "其他标签页" }, readManualDraftRaw(owner));
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: window.localStorage.key(0), newValue: foreign.raw })));
    expect(screen.getByRole("alert")).toHaveTextContent("另一页面更改");
    fill("当前页面继续输入");
    expect(readManualDraftRaw(owner)).toBe(foreign.raw);
  });
  it("rechecks raw storage at restore time even when a storage event was delayed", async () => {
    const original = await writeManualDraft(owner, input, null);
    render(element());
    fill("不得替换的当前输入");
    fireEvent.click(screen.getByLabelText("确认恢复替换当前输入"));
    const foreign = await writeManualDraft(owner, { ...input, text: "迟到事件的改动" }, original.raw);
    fireEvent.click(screen.getByRole("button", { name: "恢复本地草稿" }));
    expect(screen.getByRole("alert")).toHaveTextContent("草稿已变化");
    expect(screen.getByLabelText("待导入文字")).toHaveValue("不得替换的当前输入");
    expect(readManualDraftRaw(owner)).toBe(foreign.raw);
  });
  it("does not delete another tab's replacement when server save finishes", async () => {
    let finish: ((value: object) => void) | undefined;
    api.saveManualText.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(element());
    fill();
    await enable();
    await save();
    await waitFor(() => expect(api.saveManualText).toHaveBeenCalledOnce());
    const foreign = await writeManualDraft(owner, { ...input, text: "其他页面更新" }, readManualDraftRaw(owner));
    await act(async () => {
      finish?.({ memo: "memos/mwt-synthetic", status: "imported" });
    });
    expect(readManualDraftRaw(owner)).toBe(foreign.raw);
    expect(screen.getByRole("alert")).toHaveTextContent("未删除");
  });
  it("does not let an old account's late successful save clean up either account's draft", async () => {
    let finish: ((value: object) => void) | undefined;
    api.saveManualText.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const foreign = await writeManualDraft(other, { ...input, text: "另一个账号" }, null);
    const view = render(element());
    fill();
    await enable();
    await save();
    await waitFor(() => expect(api.saveManualText).toHaveBeenCalledOnce());
    const old = readManualDraftRaw(owner);
    view.rerender(element(other));
    await act(async () => {
      finish?.({ memo: "memos/mwt-synthetic", status: "imported" });
    });
    expect(readManualDraftRaw(owner)).toBe(old);
    expect(readManualDraftRaw(other)).toBe(foreign.raw);
    expect(screen.getByLabelText("待导入文字")).toHaveValue("");
    expect(onSaved).not.toHaveBeenCalled();
  });
  it("keeps previous orphan receipt IDs after a later retry verifies another attachment, without persisting IDs", async () => {
    api.saveManualText
      .mockImplementationOnce(async (_plan, _signal, update) => {
        update({ memo: "memos/mwt-synthetic", status: "uploaded", attachment: "attachments/orphan" });
        throw new Error("memo write unknown");
      })
      .mockImplementationOnce(async (_plan, _signal, update) => {
        update({ memo: "memos/mwt-synthetic", status: "prepared" });
        return { memo: "memos/mwt-synthetic", status: "verified", attachment: "attachments/winner" };
      });
    render(element());
    fill();
    await save();
    await screen.findByText("memo write unknown");
    fireEvent.click(screen.getByRole("button", { name: "保存文本原件与正文" }));
    await screen.findByText("已有原件与正文已核验，未重复创建。");
    expect(screen.getByText(/本会话全部已知附件回执/)).toHaveTextContent("attachments/orphan、attachments/winner");
    expect(window.localStorage.length).toBe(0);
  });
  it.each(["stop", "unmount", "account", "file"])("cancels a queued draft write on %s", async (action) => {
    const key = `youji:manual-draft:v2:${encodeURIComponent(window.location.origin)}:${encodeURIComponent(owner)}`;
    let release!: () => void;
    const held = locks.request(
      key,
      { mode: "exclusive" },
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    const view = render(element());
    fill();
    await enable();
    expect(readManualDraft(owner)).toBeNull();
    if (action === "stop") fireEvent.click(screen.getByRole("button", { name: "停止本地草稿保存" }));
    if (action === "unmount") view.unmount();
    if (action === "account") view.rerender(element(other));
    if (action === "file") fireEvent.click(screen.getByRole("button", { name: "选择文本文件" }));
    await act(async () => {
      release();
      await held;
    });
    expect(readManualDraft(owner)).toBeNull();
    expect(readManualDraft(other)).toBeNull();
    if (action === "account") expect(screen.getByLabelText("待导入文字")).toHaveValue("");
  });
  it("recovers legacy plaintext only after consent and never deletes or migrates it", async () => {
    const key = `youji:manual-draft:v1:${encodeURIComponent(window.location.origin)}:${encodeURIComponent(owner)}`;
    const raw = JSON.stringify({ ...input, version: 1, owner, origin: window.location.origin, updatedAt: 1795000000000 });
    localStorage.setItem(key, raw);
    render(element());
    expect(screen.getByRole("button", { name: "只读恢复旧版草稿" })).toBeDisabled();
    expect(screen.getByLabelText("待导入文字")).toHaveValue("");
    fireEvent.click(screen.getByLabelText("确认旧版恢复替换当前输入"));
    fireEvent.click(screen.getByRole("button", { name: "只读恢复旧版草稿" }));
    expect(screen.getByLabelText("待导入文字")).toHaveValue(input.text);
    expect(document.querySelector("img")).toBeNull();
    expect(readManualDraft(owner)).toBeNull();
    await save();
    await screen.findByText(/已仅自己可见保存/);
    expect(localStorage.getItem(key)).toBe(raw);
    expect(screen.queryByRole("button", { name: "删除本地草稿并停止保存" })).not.toBeInTheDocument();
  });
  it("stops persistence with a useful message when Web Locks is unavailable", async () => {
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    render(element());
    fill();
    await enable();
    expect(screen.getByRole("alert")).toHaveTextContent("HTTPS 或 localhost");
    expect(readManualDraft(owner)).toBeNull();
    expect(screen.getByLabelText("待导入文字")).toHaveValue(input.text);
  });
});

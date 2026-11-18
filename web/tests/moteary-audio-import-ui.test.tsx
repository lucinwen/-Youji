import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AudioImport from "@/components/MotearyWorkspace/AudioImport";

const api = vi.hoisted(() => ({ prepareAudio: vi.fn(), audioWithTranscript: vi.fn(), transcribeAudio: vi.fn(), saveAudio: vi.fn() }));
vi.mock("@/components/MotearyWorkspace/audioImport", () => api);
const saved = vi.fn();
const mount = () =>
  render(
    <MemoryRouter>
      <AudioImport userName="users/test" onSaved={saved} />
    </MemoryRouter>,
  );
const select = () => fireEvent.change(screen.getByLabelText("音频原件"), { target: { files: [new File(["synthetic"], "synthetic.wav")] } });
const edit = () => {
  fireEvent.change(screen.getByLabelText("人工校订稿"), { target: { value: "人工核对文字" } });
  fireEvent.click(screen.getByRole("checkbox"));
};
beforeEach(() => {
  vi.clearAllMocks();
  api.prepareAudio.mockResolvedValue({});
  api.audioWithTranscript.mockReturnValue({});
  api.transcribeAudio.mockReset();
  api.saveAudio.mockReset();
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:synthetic") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
});
afterEach(cleanup);
it("never auto-transcribes, requires explicit confirmation, and supports manual-only save", async () => {
  api.saveAudio.mockResolvedValue({ memo: "memos/stable", status: "imported" });
  mount();
  select();
  expect(api.transcribeAudio).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "保存音频与校订稿" })).toBeDisabled();
  edit();
  fireEvent.click(screen.getByRole("button", { name: "保存音频与校订稿" }));
  await screen.findByText("原件和稿件已保存到同一条仅自己可见记录。");
  expect(saved).toHaveBeenCalledOnce();
  expect(screen.getByRole("link")).toHaveAttribute("href", "/memos/stable");
  expect(api.transcribeAudio).not.toHaveBeenCalled();
});
it("renders a machine draft as plain text without silently filling or saving the human draft", async () => {
  api.transcribeAudio.mockResolvedValue({
    text: "<img src=x>",
    engine: "faster-whisper",
    model: "local",
    revision: "fixed",
    language: "zh",
  });
  mount();
  select();
  fireEvent.click(screen.getByRole("button", { name: "本地转写预览（实验）" }));
  expect(await screen.findByText("<img src=x>")).toBeInTheDocument();
  expect(document.querySelector("img")).toBeNull();
  expect(screen.getByLabelText("人工校订稿")).toHaveValue("");
  expect(api.saveAudio).not.toHaveBeenCalled();
});
it("retains the uncertain upload receipt after failure for recovery", async () => {
  api.saveAudio.mockImplementation(async (_item, _signal, callback) => {
    callback({ memo: "memos/stable", status: "upload-unknown", archive: "synthetic.wav.original.zip" });
    throw new Error("原件上传结果未知");
  });
  mount();
  select();
  edit();
  fireEvent.click(screen.getByRole("button", { name: "保存音频与校订稿" }));
  await screen.findByText("原件上传结果未知");
  expect(screen.getByRole("button", { name: "下载恢复回执" })).toBeInTheDocument();
  expect(saved).not.toHaveBeenCalled();
});
it.each(["cancel", "unmount"])("ignores a late save result after %s", async (reason) => {
  let finish: ((result: object) => void) | undefined;
  api.saveAudio.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = mount();
  select();
  edit();
  fireEvent.click(screen.getByRole("button", { name: "保存音频与校订稿" }));
  await waitFor(() => expect(api.saveAudio).toHaveBeenCalledOnce());
  const signal = api.saveAudio.mock.calls[0][1];
  if (reason === "cancel") fireEvent.click(screen.getByRole("button", { name: "取消当前操作" }));
  else view.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => {
    finish?.({ memo: "memos/stable", status: "imported" });
  });
  expect(saved).not.toHaveBeenCalled();
  if (reason === "cancel") expect(screen.getByText(/不代表撤回已提交保存/)).toBeInTheDocument();
});
it.each(["close", "replace", "unmount"])("only plays local audio on demand and releases the blob on %s", (reason) => {
  const view = mount();
  select();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "试听所选本机音频" }));
  expect(screen.getByLabelText("所选本机音频播放器")).toHaveAttribute("src", "blob:synthetic");
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  expect(api.transcribeAudio).not.toHaveBeenCalled();
  if (reason === "close") fireEvent.click(screen.getByRole("button", { name: "关闭本机试听" }));
  else if (reason === "replace") select();
  else view.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:synthetic");
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
});
it("copies machine text only into an empty human draft and seeks without playing", async () => {
  api.transcribeAudio.mockResolvedValue({
    text: "机器文本",
    segments: [
      { start: 2, end: 3, text: "second" },
      { start: 50, end: 60, text: "outside" },
    ],
  });
  mount();
  select();
  fireEvent.click(screen.getByRole("button", { name: "试听所选本机音频" }));
  fireEvent.click(screen.getByRole("button", { name: "本地转写预览（实验）" }));
  await screen.findByText("机器文本");
  fireEvent.click(screen.getByText("查看机器稿（可能严重错误）"));
  fireEvent.click(screen.getByRole("button", { name: "复制机器稿到空白校订区" }));
  expect(screen.getByLabelText("人工校订稿")).toHaveValue("机器文本");
  expect(screen.getByRole("checkbox")).not.toBeChecked();
  expect(screen.getByRole("button", { name: "复制机器稿到空白校订区" })).toBeDisabled();
  const audio = screen.getByLabelText("所选本机音频播放器") as HTMLAudioElement;
  Object.defineProperty(audio, "duration", { value: 10 });
  fireEvent.click(screen.getByRole("button", { name: "2–3 秒 · 定位" }));
  expect(audio.currentTime).toBe(2);
  fireEvent.click(screen.getByRole("button", { name: "50–60 秒 · 定位" }));
  expect(audio.currentTime).toBe(2);
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
});

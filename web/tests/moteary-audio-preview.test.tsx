import { createHash, webcrypto } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_FILE, verifyOriginalArchive } from "@/components/MotearyWorkspace/batchImport";
import OriginalAudioPreview, { getOriginalAudio } from "@/components/MotearyWorkspace/OriginalAudioPreview";
import { MemoSchema } from "@/types/proto/api/memo_service_pb";

vi.mock("@/auth-state", () => ({ getAccessToken: () => "synthetic-test-token" }));
// Valid PCM WAV header and a short silent payload, generated entirely in the test.
const bytes = new Uint8Array(60);
const view = new DataView(bytes.buffer);
for (const [offset, value] of [
  [0, "RIFF"],
  [8, "WAVE"],
  [12, "fmt "],
  [36, "data"],
] as const)
  bytes.set(new TextEncoder().encode(value), offset);
view.setUint32(4, 52, true);
view.setUint32(16, 16, true);
view.setUint16(20, 1, true);
view.setUint16(22, 1, true);
view.setUint32(24, 8000, true);
view.setUint32(28, 16000, true);
view.setUint16(32, 2, true);
view.setUint16(34, 16, true);
view.setUint32(40, 16, true);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const original = { name: "attachments/synthetic-1", filename: "合成.wav", type: "audio/wav", sha256 };
const archive = new Uint8Array(zipSync({ [original.filename]: bytes }));
// Fixtures from zipSync have no ZIP comment; walk central-directory records.
const centralEntries = (zip: Uint8Array) => {
  const data = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const offsets: number[] = [];
  let offset = data.getUint32(zip.length - 6, true);
  const count = data.getUint16(zip.length - 14, true);
  for (let index = 0; index < count; index++) {
    offsets.push(offset);
    offset += 46 + data.getUint16(offset + 28, true) + data.getUint16(offset + 30, true) + data.getUint16(offset + 32, true);
  }
  return { data, offsets };
};
const memo = () =>
  create(MemoSchema, {
    content: `原件 SHA-256：\`${sha256}\``,
    attachments: [{ name: original.name, filename: `${original.filename}.original.zip` }],
  });
const createUrl = vi.fn();
const revokeUrl = vi.fn();
const fetchMock = vi.fn();
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal(
    "fetch",
    fetchMock.mockReset().mockImplementation(async () => new Response(archive)),
  );
  createUrl.mockReset().mockReturnValue("blob:synthetic-audio");
  revokeUrl.mockReset();
  vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL: createUrl, revokeObjectURL: revokeUrl }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const open = () => fireEvent.click(screen.getByRole("button", { name: "校验并试听原件" }));

describe("bounded verified original audio", () => {
  it("only selects one local audio archive with an unambiguous hash", () => {
    expect(getOriginalAudio(memo())).toEqual(original);
    const external = memo();
    external.attachments[0].externalLink = "https://example.invalid/private";
    expect(getOriginalAudio(external)).toBeUndefined();
    const noHash = memo();
    noHash.content = "no hash";
    expect(getOriginalAudio(noHash)).toBeUndefined();
    const twoHashes = memo();
    twoHashes.content += `\n${twoHashes.content}`;
    expect(getOriginalAudio(twoHashes)).toBeUndefined();
    const path = memo();
    path.attachments[0].filename = "../secret.wav.original.zip";
    expect(getOriginalAudio(path)).toBeUndefined();
    const id = memo();
    id.attachments[0].name = "attachments/../secret";
    expect(getOriginalAudio(id)).toBeUndefined();
    const duplicate = memo();
    duplicate.attachments.push(duplicate.attachments[0]);
    expect(getOriginalAudio(duplicate)).toBeUndefined();
  });
  it("does not fetch before intent, verifies bytes and provides a non-autoplay player and original download", async () => {
    render(<OriginalAudioPreview original={original} />);
    expect(fetchMock).not.toHaveBeenCalled();
    const trigger = screen.getByRole("button", { name: "校验并试听原件" });
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    const player = await screen.findByLabelText(`试听 ${original.filename}`);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      `/file/${original.name}/${encodeURIComponent(`${original.filename}.original.zip`)}`,
      expect.objectContaining({
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        headers: { Authorization: "Bearer synthetic-test-token" },
      }),
    );
    expect(player).toHaveAttribute("preload", "none");
    expect(player).not.toHaveAttribute("autoplay");
    const blob = createUrl.mock.calls[0][0] as Blob;
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    expect(blob.type).toBe("audio/wav");
    expect(screen.getByRole("link", { name: "下载已校验音频原件" })).toHaveAttribute("download", original.filename);
    fireEvent.error(player);
    expect(screen.getByRole("alert")).toHaveTextContent("本机播放器");
    expect(screen.getByRole("link", { name: "下载已校验音频原件" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭试听并释放" }));
    expect(revokeUrl).toHaveBeenCalledWith("blob:synthetic-audio");
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(player).not.toHaveAttribute("src");
    expect(screen.queryByLabelText(`试听 ${original.filename}`)).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
  it.each([
    "denied",
    "corrupt",
    "mismatch",
    "oversized",
    "multiple",
  ])("never exposes bytes after %s failure and supports retry", async (failure) => {
    if (failure === "denied") fetchMock.mockResolvedValueOnce(new Response("private server detail", { status: 401 }));
    if (failure === "corrupt") fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    if (failure === "mismatch")
      fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(zipSync({ [original.filename]: new Uint8Array([1]) }))));
    if (failure === "multiple")
      fetchMock.mockResolvedValueOnce(new Response(new Uint8Array(zipSync({ [original.filename]: bytes, "extra.txt": bytes }))));
    if (failure === "oversized")
      fetchMock.mockResolvedValueOnce(new Response(archive, { headers: { "content-length": String(MAX_FILE * 2) } }));
    render(<OriginalAudioPreview original={original} />);
    open();
    expect(await screen.findByRole("alert")).not.toHaveTextContent("private server detail");
    expect(createUrl).not.toHaveBeenCalled();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    open();
    await screen.findByLabelText(`试听 ${original.filename}`);
  });
  it("releases the object URL on unmount, including account-scoped workspace removal", async () => {
    const { unmount } = render(<OriginalAudioPreview original={original} />);
    open();
    await screen.findByLabelText(`试听 ${original.filename}`);
    unmount();
    expect(revokeUrl).toHaveBeenCalledOnce();
  });
  it("cancels a stalled stream and does not publish a late result", async () => {
    const cancel = vi.fn();
    fetchMock.mockResolvedValue(new Response(new ReadableStream({ cancel })));
    render(<OriginalAudioPreview original={original} />);
    open();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "取消读取" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(createUrl).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("aborts on unmount even if the fetch ignores cancellation", async () => {
    let resolve!: (response: Response) => void;
    fetchMock.mockReturnValue(
      new Promise<Response>((done) => {
        resolve = done;
      }),
    );
    const { unmount } = render(<OriginalAudioPreview original={original} />);
    open();
    unmount();
    await act(async () => {
      resolve(new Response(archive));
    });
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    expect(createUrl).not.toHaveBeenCalled();
  });
  it("rejects a ZIP containing a compressed original above the decoded limit", async () => {
    const oversized = zipSync({ [original.filename]: new Uint8Array(MAX_FILE + 1) });
    await expect(verifyOriginalArchive(oversized, original.filename, sha256)).rejects.toThrow("校验未通过");
  });
  it("rejects extra highly compressed entries before attempting their decoding", async () => {
    const zip = zipSync({ [original.filename]: bytes, "extra-a.bin": new Uint8Array(MAX_FILE), "extra-b.bin": new Uint8Array(MAX_FILE) });
    expect(zip.length).toBeLessThan(100_000);
    const { data, offsets } = centralEntries(zip);
    // If the filter admits this entry, fflate throws 'unknown compression type'
    // instead of our validation error. No second decoded allocation is allowed.
    data.setUint16(offsets[1] + 10, 99, true);
    await expect(verifyOriginalArchive(zip, original.filename, sha256)).rejects.toThrow("校验未通过");
  });
  it("rejects a non-target first entry before attempting its decoding", async () => {
    const zip = zipSync({ "wrong.wav": new Uint8Array(MAX_FILE), [original.filename]: bytes });
    const { data, offsets } = centralEntries(zip);
    data.setUint16(offsets[0] + 10, 99, true);
    await expect(verifyOriginalArchive(zip, original.filename, sha256)).rejects.toThrow("校验未通过");
  });
  it("rejects duplicate names before decoding the second entry", async () => {
    const zip = zipSync({ "a.wav": bytes, "b.wav": new Uint8Array(MAX_FILE) });
    const { data, offsets } = centralEntries(zip);
    zip[offsets[1] + 46] = "a".charCodeAt(0);
    data.setUint16(offsets[1] + 10, 99, true);
    await expect(verifyOriginalArchive(zip, "a.wav", sha256)).rejects.toThrow("校验未通过");
  });
  it.each([0, bytes.length - 1, MAX_FILE + 1])("rejects inconsistent stored-entry size %s", async (size) => {
    const zip = zipSync({ [original.filename]: bytes }, { level: 0 });
    const { data, offsets } = centralEntries(zip);
    data.setUint32(offsets[0] + 24, size, true);
    await expect(verifyOriginalArchive(zip, original.filename, sha256)).rejects.toThrow("校验未通过");
  });
});

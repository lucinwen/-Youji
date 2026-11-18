import { useEffect, useRef, useState } from "react";
import { getAccessToken } from "@/auth-state";
import { Button } from "@/components/ui/button";
import type { Memo } from "@/types/proto/api/memo_service_pb";
import { readOriginalArchive, verifyOriginalArchive } from "./batchImport";

const AUDIO_TYPES: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  webm: "audio/webm",
};
interface OriginalAudio {
  name: string;
  filename: string;
  sha256: string;
  type: string;
}

// A hash in editable memo text checks consistency, not provenance or authenticity.
export function getOriginalAudio(memo: Memo): OriginalAudio | undefined {
  const hashes = [...memo.content.matchAll(/^原件 SHA-256：`([a-f0-9]{64})`$/gm)];
  if (hashes.length !== 1) return;
  const archives = memo.attachments.filter((attachment) => !attachment.externalLink && attachment.filename.endsWith(".original.zip"));
  if (archives.length !== 1) return;
  const attachment = archives[0];
  const filename = attachment.filename.slice(0, -".original.zip".length);
  const extension = filename.split(".").at(-1)?.toLowerCase() ?? "";
  const type = Object.hasOwn(AUDIO_TYPES, extension) ? AUDIO_TYPES[extension] : undefined;
  if (
    !type ||
    !filename ||
    /[\\/]/.test(filename) ||
    Array.from(filename).some((c) => c.charCodeAt(0) < 32) ||
    !/^attachments\/[a-zA-Z0-9-]+$/.test(attachment.name)
  )
    return;
  return { name: attachment.name, filename, type, sha256: hashes[0][1] };
}

export default function OriginalAudioPreview({ original }: { original: OriginalAudio }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const objectUrl = useRef("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (!url) return;
    const audio = audioRef.current;
    return () => {
      audio?.pause();
      audio?.removeAttribute("src");
      audio?.load();
    };
  }, [url]);
  useEffect(
    () => () => {
      request.current?.abort();
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );
  const close = () => {
    request.current?.abort();
    request.current = null;
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = "";
    setUrl("");
    setBusy(false);
    setError("");
  };
  const load = async () => {
    if (request.current || objectUrl.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      const token = getAccessToken();
      const response = await fetch(`/file/${original.name}/${encodeURIComponent(`${original.filename}.original.zip`)}`, {
        signal: controller.signal,
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) throw new Error("download failed");
      const archive = await readOriginalArchive(response, controller.signal);
      const bytes = await verifyOriginalArchive(archive, original.filename, original.sha256);
      controller.signal.throwIfAborted();
      objectUrl.current = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: original.type }));
      setUrl(objectUrl.current);
    } catch {
      if (!controller.signal.aborted) setError("原件无法读取或校验未通过，请检查登录、网络与记录。未播放或提供未校验的音频。");
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy(false);
      }
    }
  };
  return (
    <section aria-label={`音频原件 ${original.filename}`} className="mx-5 mb-5 min-w-0 border-t border-border pt-3 text-xs">
      <p className="mb-2 leading-5 text-muted-foreground">
        按需读取不超过 16 MiB 的归档原件，与记录中的 SHA-256 核对后试听；本试听操作不执行转写。已有稿件仍需核对原声，校验值不代表来源认证。
      </p>
      {!url && (
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void load()}>
          {busy ? "正在读取并校验…" : "校验并试听原件"}
        </Button>
      )}
      {url && (
        <>
          <audio
            ref={audioRef}
            aria-label={`试听 ${original.filename}`}
            controls
            preload="none"
            src={url}
            className="w-full min-w-0 max-w-full"
            onError={() => setError("浏览器无法播放此音频格式，可下载已校验原件使用本机播放器打开。")}
          />
          <p role="status" className="my-2">
            已与记录中的校验值一致；请对照原声核对稿件。
          </p>
          <a href={url} download={original.filename} className="inline-block min-h-10 py-3 underline">
            下载已校验音频原件
          </a>
        </>
      )}
      {(busy || url) && (
        <Button type="button" size="sm" variant="ghost" onClick={close}>
          {busy ? "取消读取" : "关闭试听并释放"}
        </Button>
      )}
      {error && (
        <p role="alert" className="mt-2 text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

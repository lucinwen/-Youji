import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  type AudioReceipt,
  type AudioTranscript,
  audioWithTranscript,
  encodeAudioDraft,
  prepareAudio,
  restoreAudioDraft,
  saveAudio,
  transcribeAudio,
} from "./audioImport";

export default function AudioImport({ userName, onSaved }: { userName: string; onSaved: () => void }) {
  const [file, setFile] = useState<File>();
  const [text, setText] = useState("");
  const [machine, setMachine] = useState<AudioTranscript>();
  const [confirmed, setConfirmed] = useState(false);
  const [receipt, setReceipt] = useState<AudioReceipt>();
  const [receipts, setReceipts] = useState<AudioReceipt[]>([]);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const controller = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrl = useRef("");
  const [audioUrl, setAudioUrl] = useState("");
  useEffect(() => {
    if (!audioUrl) return;
    const audio = audioRef.current;
    return () => {
      audio?.pause();
      audio?.removeAttribute("src");
      audio?.load();
    };
  }, [audioUrl]);
  const releaseAudio = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current?.removeAttribute("src");
    audioRef.current?.load();
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = "";
  }, []);
  useEffect(() => {
    setFile(undefined);
    setText("");
    setMachine(undefined);
    setReceipt(undefined);
    setReceipts([]);
    setConfirmed(false);
    setBusy("");
    setMessage("");
    setAudioUrl("");
    return () => {
      controller.current?.abort();
      controller.current = null;
      releaseAudio();
    };
  }, [userName, releaseAudio]);
  const run = async (action: "转写" | "保存" | "读稿" | "备份" | "恢复", transcript?: File) => {
    if (controller.current || !file || (action === "保存" && !confirmed)) return;
    if (action === "恢复" && (!transcript || text.length > 0)) return;
    const abort = new AbortController();
    controller.current = abort;
    const active = () => controller.current === abort && !abort.signal.aborted;
    setBusy(action);
    setMessage("");
    try {
      if (action === "读稿" && transcript) {
        if (transcript.size > 256 * 1024) throw new Error("转写稿不能超过 256 KiB。");
        const edited = new TextDecoder("utf-8", { fatal: true }).decode(await transcript.arrayBuffer());
        if (active()) {
          setText(edited);
          setConfirmed(false);
        }
      } else {
        const item = await prepareAudio(file, userName);
        abort.signal.throwIfAborted();
        if (action === "备份") {
          const draft = encodeAudioDraft(item, text, machine);
          if (active()) {
            downloadJSON(draft, "youji-audio-draft.json");
            setMessage("已生成草稿下载，含敏感正文，请确认文件已保存。原音频未打包；恢复时先选同一音频，再导入草稿。");
          }
        } else if (action === "恢复" && transcript) {
          const draft = await restoreAudioDraft(transcript, item);
          if (active()) {
            setText(draft.edited);
            setMachine(draft.machine);
            setConfirmed(false);
            setMessage("草稿已恢复到本页，未上传、未转写、未保存记录。请核对原声并重新确认；JSON 信息不是服务端权限或模型真实性证明。");
          }
        } else if (action === "转写") {
          const result = await transcribeAudio(item, abort.signal);
          if (active()) {
            setMachine(result);
            setConfirmed(false);
            setMessage("机器稿仅供对照，可能严重错误。请在人工校订稿中填写核对后的内容；尚未保存。");
          }
        } else {
          const result = await saveAudio(audioWithTranscript(item, text, machine), abort.signal, (value) => {
            if (active()) {
              setReceipt(value);
              setReceipts((previous) => [...previous, value]);
            }
          });
          if (active()) {
            setReceipt(result);
            setMessage(result.status === "verified" ? "已核验已有记录，未重复创建。" : "原件和稿件已保存到同一条仅自己可见记录。");
            onSaved();
          }
        }
      }
    } catch (error) {
      if (active()) setMessage(error instanceof Error ? error.message : "操作未完成，请重试或使用人工稿。");
    } finally {
      if (active()) {
        controller.current = null;
        setBusy("");
      }
    }
  };
  const downloadJSON = (text: string, filename: string) => {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const downloadReceipt = () => {
    if (receipt) downloadJSON(JSON.stringify({ ...receipt, events: receipts }, null, 2), "youji-audio-receipt.json");
  };
  return (
    <section aria-label="音频与转写稿" className="mb-9 rounded-xl border border-border bg-card p-4">
      <h2 className="text-base font-medium">录音 / 播客原件与校订稿</h2>
      <p className="my-2 text-xs leading-6 text-muted-foreground">
        音频不超过 16
        MiB。本机试听不上传；点击转写或保存时才发送原件到你配置的有记服务器，服务器不一定在本机。转写不调用第三方云模型，最多处理 120
        秒；自动识别尚未完成验收，机器稿可能严重错误。人工稿也需核对原声；可不使用模型，直接粘贴或导入 UTF-8 稿件。
      </p>
      <label className="block text-xs">
        音频原件
        <input
          aria-label="音频原件"
          type="file"
          accept=".wav,.mp3,.ogg,.m4a,.flac,.webm"
          disabled={!!busy}
          className="block max-w-full"
          onChange={(event) => {
            releaseAudio();
            setAudioUrl("");
            setFile(event.target.files?.[0]);
            setText("");
            setMachine(undefined);
            setReceipt(undefined);
            setReceipts([]);
            setConfirmed(false);
            setMessage("");
          }}
        />
      </label>
      <div className="my-3 space-y-2">
        <Button
          variant="outline"
          disabled={!file || !!audioUrl || !!busy}
          onClick={() => {
            if (!file) return;
            if (!file.size || file.size > 16 * 1024 * 1024) {
              setMessage("音频须非空且不超过 16 MiB。");
              return;
            }
            releaseAudio();
            objectUrl.current = URL.createObjectURL(file);
            setAudioUrl(objectUrl.current);
          }}
        >
          试听所选本机音频
        </Button>
        {audioUrl && (
          <>
            <audio
              ref={audioRef}
              src={audioUrl}
              controls
              preload="metadata"
              aria-label="所选本机音频播放器"
              onError={() => setMessage("当前浏览器无法解码所选音频；仍可保留原件，不代表转写正确。")}
            />
            <Button
              variant="outline"
              onClick={() => {
                releaseAudio();
                setAudioUrl("");
              }}
            >
              关闭本机试听
            </Button>
          </>
        )}
        <p className="text-xs text-muted-foreground">试听只读取本机文件，不上传，也不会自动播放。时间标记来自机器识别，可能不准确。</p>
      </div>
      <div className="my-3 flex flex-wrap gap-2">
        <Button variant="outline" disabled={!file || !!busy || !!receipt} onClick={() => void run("转写")}>
          本地转写预览（实验）
        </Button>
        {busy && (
          <Button
            variant="outline"
            onClick={() => {
              controller.current?.abort();
              controller.current = null;
              setBusy("");
              setMessage("已取消等待，不代表撤回已提交保存。请保留回执并重试核验；可能已有原件附件或记录。");
            }}
          >
            取消当前操作
          </Button>
        )}
      </div>
      {machine && (
        <details className="my-3">
          <summary>查看机器稿（可能严重错误）</summary>
          <p className="break-all text-xs">
            {machine.engine} · {machine.model} · {machine.revision} · {machine.language}
          </p>
          <pre className="whitespace-pre-wrap break-words text-xs">{machine.text}</pre>
          <Button
            variant="outline"
            disabled={!!text || !!busy}
            onClick={() => {
              if (!text) {
                setText(machine.text);
                setConfirmed(false);
              }
            }}
          >
            复制机器稿到空白校订区
          </Button>
          <p className="text-xs">已有人工稿时不会覆盖；复制后仍需人工核对并确认。</p>
          <ol className="max-h-64 overflow-auto space-y-2 text-xs">
            {machine.segments?.map((segment, index) => (
              <li key={`${index}:${segment.start}`}>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!audioUrl}
                  onClick={() => {
                    const audio = audioRef.current;
                    if (!audio || !Number.isFinite(audio.duration) || segment.start < 0 || segment.start > audio.duration) {
                      setMessage("播放器时长尚不可用或时间标记超出音频范围，未跳转。");
                      return;
                    }
                    audio.currentTime = segment.start;
                  }}
                >
                  {segment.start}–{segment.end} 秒 · 定位
                </Button>
                <span className="whitespace-pre-wrap break-words"> {segment.text}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
      <label className="block text-xs">
        导入 UTF-8 转写稿
        <input
          aria-label="导入 UTF-8 转写稿"
          type="file"
          accept=".txt,.md"
          disabled={!file || !!busy}
          className="block max-w-full"
          onChange={(event) => {
            const selected = event.target.files?.[0];
            if (selected) void run("读稿", selected);
            event.target.value = "";
          }}
        />
      </label>
      <label className="my-3 block text-sm">
        人工校订稿
        <textarea
          aria-label="人工校订稿"
          disabled={!!busy}
          value={text}
          className="mt-1 min-h-32 w-full rounded border border-border p-2"
          onChange={(event) => {
            setText(event.target.value);
            setConfirmed(false);
          }}
        />
      </label>
      <label className="mb-3 flex gap-2 text-xs">
        <input type="checkbox" checked={confirmed} disabled={!!busy} onChange={(event) => setConfirmed(event.target.checked)} />
        我已核对人工稿，并确认以仅自己可见保存原件与稿件
      </label>
      <div className="my-3 space-y-2 rounded border border-border p-3 text-xs" aria-label="音频校订草稿备份与恢复">
        <p>刷新前可下载 JSON 草稿，含人工稿和可选机器稿等敏感正文，请妥善保管。原音频不打包，不自动保存，也不写入浏览器存储。</p>
        <Button variant="outline" disabled={!file || !!busy || (!text && !machine)} onClick={() => void run("备份")}>
          下载校订草稿 JSON
        </Button>
        <label className="block">
          恢复校订草稿 JSON
          <input
            aria-label="恢复校订草稿 JSON"
            type="file"
            accept=".json,application/json"
            disabled={!file || !!busy || text.length > 0}
            className="block max-w-full"
            onChange={(event) => {
              const selected = event.target.files?.[0];
              if (selected) void run("恢复", selected);
              event.target.value = "";
            }}
          />
        </label>
        <p>
          恢复步骤：重新选择同一原音频 → 人工校订区保持空白 → 导入草稿。已有人工稿时禁止覆盖，请先备份并自行清空。仅核对文件与账户标识，不把
          JSON 当权限或真实性证明；恢复后仍需重新确认保存。
        </p>
      </div>
      <Button disabled={!file || !text.trim() || !confirmed || !!busy} onClick={() => void run("保存")}>
        保存音频与校订稿
      </Button>
      {busy && (
        <p role="status" className="mt-2 text-xs">
          正在{busy}…
        </p>
      )}
      {message && (
        <p role="status" className="mt-2 text-xs">
          {message}
        </p>
      )}
      {receipt && (
        <div className="mt-3 space-y-2 break-all text-xs">
          <p>
            回执状态：{receipt.status} · 记录 {receipt.memo} · 附件 {receipt.attachment ?? "尚无附件 ID，上传结果可能未知"}
          </p>
          <Button variant="outline" onClick={downloadReceipt}>
            下载恢复回执
          </Button>
          <p>
            本次会话全部已知附件：
            {[...new Set(receipts.flatMap((entry) => (entry.attachment ? [entry.attachment] : [])))].join("、") || "尚无 ID"}
            。重试不会从回执历史移除先前上传信息；请核对是否有未关联残留。
          </p>
          <Link className="block underline" to={`/${receipt.memo}`}>
            打开原件与稿件记录（保存后可用）
          </Link>
          <p>重试会核验同一原件；修改稿件后不会静默覆盖或另建。已保存稿件请打开原记录编辑。切换文件或离开页面前请下载回执。</p>
        </div>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        原始音频字节归档为
        ZIP，保存后可在工作台校验试听。原件、机器稿和人工稿在同一条记录，删除请使用原记录的删除功能；未关联上传、对象存储及备份可能仍有残留，请在附件管理核对。这不是物理擦除，也不会按正文链接删除其他记录。
      </p>
    </section>
  );
}

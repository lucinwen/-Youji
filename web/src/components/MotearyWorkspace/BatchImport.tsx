import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { type BatchSource, ingestBatchSource, prepareBatch } from "./batchImport";
import { CATEGORY_LABELS, type CaptureCategory } from "./sources";

export default function BatchImport({ onSaved, userName }: { onSaved: () => void; userName: string }) {
  const [files, setFiles] = useState<File[]>([]);
  const [kind, setKind] = useState<CaptureCategory>("reference");
  const [note, setNote] = useState("");
  const [items, setItems] = useState<BatchSource[]>([]);
  const [states, setStates] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const lock = useRef(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);
  const reset = () => {
    setItems([]);
    setStates({});
    setError("");
  };
  const preview = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      setItems(await prepareBatch(files, kind, note, userName));
      setStates({});
    } catch (e) {
      setItems([]);
      setError(e instanceof Error ? e.message : "文件预检失败。");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const upload = async () => {
    if (lock.current || !items.length) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const abort = new AbortController();
    controller.current = abort;
    try {
      for (const item of items) {
        if (abort.signal.aborted) break;
        setStates((s) => ({ ...s, [item.id]: "正在保存 / 核验" }));
        try {
          const result = await ingestBatchSource(item, abort.signal);
          setStates((s) => ({ ...s, [item.id]: result.status === "verified" ? "已复核原件" : "已保存" }));
          onSaved();
        } catch {
          setStates((s) => ({ ...s, [item.id]: "需检查" }));
          setError("已停止。当前项可能已写入，请先检查记录；再次点击保存会复核原件，不覆盖已改正文。可能存在未关联附件，不会自动删除。");
          break;
        }
      }
    } finally {
      controller.current = null;
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="mb-9 rounded-xl border border-border bg-card p-5" aria-label="批量原件导入">
      <h2 className="text-lg font-semibold">一次收好一组材料</h2>
      <p className="my-2 text-xs leading-5 text-muted-foreground">
        选择本机文件，先预检再保存。全部私有，原件以 ZIP 保留；不会调用 AI。每批最多 32 个文件、32 MiB，单文件最多 16
        MiB。批量记录不加入空间。
      </p>
      <fieldset disabled={busy} className="flex flex-col gap-3 disabled:opacity-60">
        <label className="text-sm">
          选择多个资料
          <input
            ref={fileInput}
            aria-label="批量资料文件"
            type="file"
            multiple
            className="mt-1 block max-w-full text-xs"
            onChange={(e) => {
              setFiles(Array.from(e.target.files ?? []));
              reset();
            }}
          />
        </label>
        <label className="text-sm">
          批量分类{" "}
          <select
            aria-label="批量分类"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as CaptureCategory);
              reset();
            }}
          >
            {Object.entries(CATEGORY_LABELS).map(([key, value]) => (
              <option key={key} value={key}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          共同批注
          <textarea
            aria-label="批量共同批注"
            value={note}
            maxLength={2000}
            onChange={(e) => {
              setNote(e.target.value);
              reset();
            }}
            className="mt-1 block w-full rounded border border-border bg-background p-2"
          />
        </label>
        <Button type="button" variant="outline" onClick={preview} disabled={!files.length} className="self-start">
          预检这批资料
        </Button>
      </fieldset>
      {items.length > 0 && (
        <>
          <ul className="my-4 space-y-2 text-sm">
            {items.map((item) => (
              <li key={item.id} className="flex flex-wrap justify-between gap-2 border-b border-border py-2">
                <span className="break-all">
                  {item.filename} · {(item.data.length / 1024).toFixed(1)} KiB
                </span>
                <span>{states[item.id] ?? "已预检，尚未保存"}</span>
              </li>
            ))}
          </ul>
          <Button type="button" onClick={upload} disabled={busy}>
            保存为私有记录 / 复核重试
          </Button>
        </>
      )}
      {files.length > 0 && !busy && (
        <Button
          type="button"
          variant="outline"
          className="ms-2"
          onClick={() => {
            setFiles([]);
            setNote("");
            reset();
            if (fileInput.current) fileInput.current.value = "";
          }}
        >
          清空本页队列
        </Button>
      )}
      {busy && controller.current && (
        <Button type="button" variant="outline" onClick={() => controller.current?.abort()} className="ms-2">
          停止这批导入
        </Button>
      )}
      {busy && (
        <p role="status" className="mt-3 text-sm">
          正在处理，请勿关闭页面。
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        清空队列仅移除本页文件与批注，不删除已保存记录。选择的文件与队列只留在本页内存。中断后重新选择同一文件和相同分类、批注即可复核；此界面与
        CLI 的导入身份各自独立。
      </p>
    </section>
  );
}

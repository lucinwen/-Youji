import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  deleteManualDraft,
  type ManualDraftInput,
  type ManualDraftSnapshot,
  readLegacyManualDraft,
  readManualDraft,
  readManualDraftRaw,
  writeManualDraft,
} from "./manualDraftStore";

type Props = {
  owner: string;
  mode: "paste" | "file";
  value: ManualDraftInput;
  busy: boolean;
  successfulSave: number;
  onRestore: (value: ManualDraftInput) => void;
};

export default function ManualDraftControls({ owner, mode, value, busy, successfulSave, onRestore }: Props) {
  const [snapshot, setSnapshot] = useState<ManualDraftSnapshot | null>(null);
  const [storedRaw, setStoredRaw] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [adopted, setAdopted] = useState(false);
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [restoreConfirmed, setRestoreConfirmed] = useState(false);
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const expected = useRef<string | null>(null);
  const owned = useRef(false);
  const observedSave = useRef(successfulSave);
  const [legacy, setLegacy] = useState<ManualDraftSnapshot | null>(null);
  const [legacyError, setLegacyError] = useState("");
  const [legacyConfirmed, setLegacyConfirmed] = useState(false);
  const jobs = useRef(new AbortController());
  const queue = useRef<Promise<void>>(Promise.resolve());
  const alive = useRef(true);
  const stopJobs = useCallback(() => {
    jobs.current.abort();
    jobs.current = new AbortController();
  }, []);
  const enqueue = useCallback(
    (operation: (signal: AbortSignal) => Promise<void>) => {
      const job = jobs.current;
      queue.current = queue.current
        .then(async () => {
          if (!alive.current || job.signal.aborted) return;
          await operation(job.signal);
        })
        .catch((cause) => {
          if (!alive.current || job.signal.aborted) return;
          stopJobs();
          setEnabled(false);
          setRiskAccepted(false);
          setLoaded(false);
          setRestoreConfirmed(false);
          setDeleteConfirmed(false);
          setError(cause instanceof Error ? cause.message : "本地草稿操作失败，已停止保存。请自行保留输入。");
        });
    },
    [stopJobs],
  );
  const load = useCallback(() => {
    stopJobs();
    setEnabled(false);
    setRiskAccepted(false);
    setAdopted(false);
    setRestoreConfirmed(false);
    setDeleteConfirmed(false);
    setLegacyConfirmed(false);
    setLegacy(null);
    setLegacyError("");
    setSnapshot(null);
    setStoredRaw(null);
    setLoaded(false);
    setError("");
    setMessage("");
    owned.current = false;
    expected.current = null;
    try {
      const found = readManualDraft(owner);
      setSnapshot(found);
      setStoredRaw(found?.raw ?? null);
      expected.current = found?.raw ?? null;
      setLoaded(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法读取本地草稿，未恢复或保存。");
      try {
        const raw = readManualDraftRaw(owner);
        expected.current = raw;
        setStoredRaw(raw);
      } catch (rawError) {
        setError((previous) => `${previous} ${rawError instanceof Error ? rawError.message : "无法安全读取草稿。"}`);
      }
    }
    try {
      setLegacy(readLegacyManualDraft(owner));
    } catch {
      setLegacyError("旧版草稿无法读取或解析。本入口不修改或删除它，请在浏览器站点数据中核对。");
    }
  }, [owner, stopJobs]);
  useEffect(() => {
    alive.current = true;
    load();
    return () => {
      alive.current = false;
      stopJobs();
    };
  }, [load, stopJobs]);
  useEffect(() => {
    const changed = () => {
      try {
        if (readManualDraftRaw(owner) === expected.current) return;
        setError("本地草稿已被另一页面更改，已停止自动保存。请重新检查后核对，当前输入不会被覆盖。");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "无法核对本地草稿，已停止保存。");
      }
      stopJobs();
      setEnabled(false);
      setRiskAccepted(false);
      setLoaded(false);
      setRestoreConfirmed(false);
      setDeleteConfirmed(false);
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [owner, stopJobs]);
  useEffect(() => {
    if (mode !== "paste") {
      stopJobs();
      setEnabled(false);
      setRiskAccepted(false);
    }
  }, [mode, stopJobs]);
  useEffect(() => {
    if (!enabled || mode !== "paste" || !loaded) return;
    const input = { text: value.text, title: value.title, source: value.source };
    enqueue(async (signal) => {
      const next = await writeManualDraft(owner, input, expected.current, signal);
      if (signal.aborted || !alive.current) return;
      expected.current = next.raw;
      owned.current = true;
      setSnapshot(next);
      setStoredRaw(next.raw);
      setAdopted(true);
      setMessage("已在本浏览器明文保存草稿；尚未上传记录。");
      setError("");
    });
  }, [enabled, loaded, mode, owner, value.text, value.title, value.source, enqueue]);
  useEffect(() => {
    if (observedSave.current === successfulSave) return;
    observedSave.current = successfulSave;
    stopJobs();
    setEnabled(false);
    setRiskAccepted(false);
    if (!owned.current) return;
    owned.current = false;
    enqueue(async (signal) => {
      await deleteManualDraft(owner, expected.current, signal);
      if (signal.aborted || !alive.current) return;
      expected.current = null;
      setStoredRaw(null);
      setSnapshot(null);
      setAdopted(false);
      setLoaded(true);
      setDeleteConfirmed(false);
      setRestoreConfirmed(false);
      setError("");
      setMessage("记录已保存，本轮新版本地草稿已清除；自动保存已停止。旧版草稿不受此操作影响。");
    });
  }, [successfulSave, owner, enqueue, stopJobs]);
  const remove = () => {
    if (!deleteConfirmed || busy || storedRaw === null) return;
    stopJobs();
    setEnabled(false);
    setRiskAccepted(false);
    setDeleteConfirmed(false);
    const confirmedRaw = storedRaw;
    enqueue(async (signal) => {
      await deleteManualDraft(owner, confirmedRaw, signal);
      if (signal.aborted || !alive.current) return;
      expected.current = null;
      owned.current = false;
      setStoredRaw(null);
      setSnapshot(null);
      setAdopted(false);
      setLoaded(true);
      setRestoreConfirmed(false);
      setError("");
      setMessage("新版本地草稿已删除，自动保存已停止。页面输入和旧版草稿仍保留。");
    });
  };
  return (
    <section aria-label="手动文本本地草稿" className="min-w-0 space-y-2 rounded border border-border p-3 text-xs">
      <h3 className="text-sm font-medium">本地草稿恢复 · 默认不保存</h3>
      <p>
        仅限粘贴模式、当前浏览器配置与当前站点。草稿为未加密明文，不跨设备同步；同源网页代码或共用浏览器的人可能读取。账号标识不是加密或认证隔离。退出账号会保留已手动启用的草稿，公共设备请明确删除。
      </p>
      <p>
        刷新回来不会自动恢复或写入。新版草稿用同一浏览器锁串行比对并写入或删除；不支持 Web Locks
        时停止写删，不回退不安全操作。旧版标签页使用独立的旧草稿，不会被本入口删除。
      </p>
      {mode !== "paste" && <p>文件模式不保存本地草稿，自动保存已停止；请保留原文件。</p>}
      <label className="flex min-h-11 items-center gap-2">
        <input
          type="checkbox"
          aria-label="同意本地明文存储风险"
          checked={riskAccepted}
          disabled={busy || mode !== "paste" || enabled}
          onChange={(event) => setRiskAccepted(event.target.checked)}
        />
        我了解明文存储风险，愿意在此浏览器保存粘贴草稿
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          className="min-h-11"
          disabled={busy || mode !== "paste" || !riskAccepted || !loaded || enabled || (storedRaw !== null && !adopted)}
          onClick={() => {
            setError("");
            setEnabled(true);
          }}
        >
          启用本地草稿保存
        </Button>
        {enabled && (
          <Button
            variant="outline"
            className="min-h-11"
            disabled={busy}
            onClick={() => {
              stopJobs();
              setEnabled(false);
              setMessage("自动保存已停止，已有本地草稿仍保留。");
            }}
          >
            停止本地草稿保存
          </Button>
        )}
        <Button variant="outline" className="min-h-11" disabled={busy} onClick={load}>
          重新检查本地草稿
        </Button>
      </div>
      {storedRaw !== null && (
        <div className="space-y-2">
          <p>
            {snapshot
              ? `发现本地草稿：${snapshot.value.title || "无标题"}，${snapshot.value.text.length} 字符。`
              : "存在无法解析的本地草稿。不会展示或恢复其原始内容，可确认删除。"}
          </p>
          {snapshot && (
            <>
              <label className="flex min-h-11 items-center gap-2">
                <input
                  type="checkbox"
                  aria-label="确认恢复替换当前输入"
                  checked={restoreConfirmed}
                  disabled={busy || mode !== "paste" || enabled || !loaded}
                  onChange={(event) => setRestoreConfirmed(event.target.checked)}
                />
                恢复会替换当前输入，我已自行保留需要的内容
              </label>
              <Button
                variant="outline"
                className="min-h-11"
                disabled={busy || mode !== "paste" || enabled || !loaded || !restoreConfirmed}
                onClick={() => {
                  try {
                    const current = readManualDraft(owner);
                    if (!current || current.raw !== expected.current)
                      throw new Error("本地草稿已变化，未替换当前输入。请重新检查并确认恢复。");
                    onRestore({ text: current.value.text, title: current.value.title, source: current.value.source });
                    owned.current = true;
                    setAdopted(true);
                    setRestoreConfirmed(false);
                    setMessage("已显式恢复到输入区，未上传，自动保存仍关闭；请重新预览并确认保存。记录保存成功后将尝试清除本轮草稿。");
                  } catch (cause) {
                    setEnabled(false);
                    setLoaded(false);
                    setRiskAccepted(false);
                    setRestoreConfirmed(false);
                    setDeleteConfirmed(false);
                    setError(cause instanceof Error ? cause.message : "恢复前核对失败，未替换当前输入。");
                  }
                }}
              >
                恢复本地草稿
              </Button>
            </>
          )}
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="checkbox"
              aria-label="确认删除本地草稿"
              checked={deleteConfirmed}
              disabled={busy}
              onChange={(event) => setDeleteConfirmed(event.target.checked)}
            />
            确认删除所检查的本地草稿（不删除服务端记录）
          </label>
          <Button variant="outline" className="min-h-11" disabled={busy || !deleteConfirmed} onClick={remove}>
            删除本地草稿并停止保存
          </Button>
        </div>
      )}
      {(legacy || legacyError) && (
        <div className="space-y-2 rounded border p-2" aria-label="旧版草稿只读恢复">
          <p>
            检测到旧版草稿或旧版读取问题。旧版内容仍留在浏览器，不自动迁移，也不由本入口删除；清理需先保留内容、关闭旧标签页，再使用浏览器站点数据设置（会清除本站点的其他本地数据及登录状态）。
          </p>
          {legacyError && <p>{legacyError}</p>}
          {legacy && (
            <>
              <p>
                旧版：{legacy.value.title || "无标题"}，{legacy.value.text.length} 字符。
              </p>
              <details>
                <summary>查看旧版文字（不执行内容）</summary>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words">{legacy.value.text}</pre>
              </details>
              <label className="flex min-h-11 items-center gap-2">
                <input
                  type="checkbox"
                  aria-label="确认旧版恢复替换当前输入"
                  checked={legacyConfirmed}
                  disabled={busy || enabled || mode !== "paste" || storedRaw !== null}
                  onChange={(event) => setLegacyConfirmed(event.target.checked)}
                />
                我确认将旧版文字恢复到输入区，旧版原数据继续保留
              </label>
              <Button
                variant="outline"
                className="min-h-11"
                disabled={busy || enabled || mode !== "paste" || storedRaw !== null || !legacyConfirmed}
                onClick={() => {
                  try {
                    const current = readLegacyManualDraft(owner);
                    if (!current || current.raw !== legacy.raw) throw new Error("旧版草稿已变化，请重新检查，未替换输入。");
                    onRestore({ text: current.value.text, title: current.value.title, source: current.value.source });
                    setLegacyConfirmed(false);
                    setMessage("旧版文字已恢复到输入区，未写入新版草稿，旧版原数据仍保留。可明确启用新版保存或预览上传。");
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : "旧版草稿恢复失败。");
                  }
                }}
              >
                只读恢复旧版草稿
              </Button>
              {storedRaw !== null && <p>已有新版草稿，不直接用旧版覆盖；可先核对并自行保留两份内容。</p>}
            </>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="break-words text-destructive">
          {error} 自动保存已关闭；请重新检查草稿或自行保留当前输入。
        </p>
      )}
      {message && (
        <p role="status" className="break-words">
          {message}
        </p>
      )}
    </section>
  );
}

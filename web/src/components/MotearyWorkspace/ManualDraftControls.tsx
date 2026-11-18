import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  deleteManualDraft,
  type ManualDraftInput,
  type ManualDraftSnapshot,
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
  const load = useCallback(() => {
    setEnabled(false);
    setRiskAccepted(false);
    setAdopted(false);
    setRestoreConfirmed(false);
    setDeleteConfirmed(false);
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
        setError((previous) => `${previous} ${rawError instanceof Error ? rawError.message : "无法读取原始草稿，暂不能安全删除。"}`);
      }
    }
  }, [owner]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    const changed = () => {
      try {
        if (readManualDraftRaw(owner) === expected.current) return;
        setError("本地草稿已被另一页面更改，已停止自动保存。请重新检查后核对，当前输入不会被覆盖。");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "无法核对本地草稿，已停止自动保存。");
      }
      setEnabled(false);
      setRiskAccepted(false);
      setLoaded(false);
      setRestoreConfirmed(false);
      setDeleteConfirmed(false);
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [owner]);
  useEffect(() => {
    if (mode !== "paste") {
      setEnabled(false);
      setRiskAccepted(false);
    }
  }, [mode]);
  useEffect(() => {
    if (!enabled || mode !== "paste" || !loaded) return;
    try {
      const next = writeManualDraft(owner, { text: value.text, title: value.title, source: value.source }, expected.current);
      expected.current = next.raw;
      owned.current = true;
      setSnapshot(next);
      setStoredRaw(next.raw);
      setAdopted(true);
      setMessage("已在本浏览器明文保存草稿；尚未上传记录。");
      setError("");
    } catch (cause) {
      setEnabled(false);
      setRiskAccepted(false);
      setLoaded(false);
      setRestoreConfirmed(false);
      setDeleteConfirmed(false);
      setError(cause instanceof Error ? cause.message : "本地保存失败，已停止自动保存。请自行保留当前输入。");
    }
  }, [enabled, loaded, mode, owner, value.text, value.title, value.source]);
  useEffect(() => {
    if (observedSave.current === successfulSave) return;
    observedSave.current = successfulSave;
    setEnabled(false);
    setRiskAccepted(false);
    if (!owned.current) return;
    owned.current = false;
    try {
      deleteManualDraft(owner, expected.current);
      expected.current = null;
      setStoredRaw(null);
      setSnapshot(null);
      setAdopted(false);
      setLoaded(true);
      setDeleteConfirmed(false);
      setRestoreConfirmed(false);
      setError("");
      setMessage("记录已保存，本轮本地草稿已清除；自动保存已停止。");
    } catch (cause) {
      setLoaded(false);
      setDeleteConfirmed(false);
      setRestoreConfirmed(false);
      setError(cause instanceof Error ? cause.message : "记录已保存，但本地草稿未能清除。请重新检查后明确删除。");
    }
  }, [successfulSave, owner]);
  const remove = () => {
    if (!deleteConfirmed || busy || storedRaw === null) return;
    setEnabled(false);
    setRiskAccepted(false);
    try {
      deleteManualDraft(owner, storedRaw);
      expected.current = null;
      owned.current = false;
      setStoredRaw(null);
      setSnapshot(null);
      setAdopted(false);
      setLoaded(true);
      setDeleteConfirmed(false);
      setRestoreConfirmed(false);
      setError("");
      setMessage("本地草稿已删除，自动保存已停止。页面输入仍保留。");
    } catch (cause) {
      setLoaded(false);
      setDeleteConfirmed(false);
      setRestoreConfirmed(false);
      setError(cause instanceof Error ? cause.message : "删除失败，未清理草稿。请重新检查。");
    }
  };
  return (
    <section aria-label="手动文本本地草稿" className="min-w-0 space-y-2 rounded border border-border p-3 text-xs">
      <h3 className="text-sm font-medium">本地草稿恢复 · 默认不保存</h3>
      <p>
        仅限粘贴模式、当前浏览器配置与当前站点。草稿为未加密明文，不跨设备同步；同源网页代码或共用浏览器的人可能读取。账号标识不是加密或认证隔离。退出账号会保留已手动启用的草稿，公共设备请明确删除。
      </p>
      <p>刷新回来不会自动恢复或写入。多标签页只做写入前比对，不是原子事务；请避免同时编辑。</p>
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

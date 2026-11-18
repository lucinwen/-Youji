import { type ManualSource, SOURCES } from "./manualTextImport";

export type ManualDraftInput = { text: string; title: string; source: ManualSource };
export type ManualDraft = ManualDraftInput & { version: 1; owner: string; origin: string; updatedAt: number };
export type ManualDraftSnapshot = { raw: string; value: ManualDraft };
const bytes = (value: string) => new TextEncoder().encode(value).length;
const context = (owner: string) => {
  if (!/^users\/[a-zA-Z0-9_-]+$/.test(owner)) throw new Error("请先登录后使用本地草稿。");
  const origin = window.location.origin;
  if (!/^https?:\/\//.test(origin)) throw new Error("当前站点不支持本地草稿。");
  return { origin, key: `youji:manual-draft:v1:${encodeURIComponent(origin)}:${encodeURIComponent(owner)}` };
};
const validate = (input: ManualDraftInput) => {
  if (
    typeof input.text !== "string" ||
    bytes(input.text) > 128 * 1024 ||
    typeof input.title !== "string" ||
    input.title.length > 200 ||
    !Object.hasOwn(SOURCES, input.source)
  )
    throw new Error("本地草稿格式或大小无效（正文最多 128 KiB）。");
};
const storageError = () => new Error("无法访问本地草稿存储，可能被浏览器禁用或空间不足。当前输入仍在页面中，请自行保留。");
function get(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    throw storageError();
  }
}

/** Raw bytes are exposed only for confirmed deletion of malformed drafts, never for restoration. */
export function readManualDraftRaw(owner: string): string | null {
  return get(context(owner).key);
}

/** Plaintext, origin/browser-profile scoped storage. Never an authentication or encryption boundary. */
export function readManualDraft(owner: string): ManualDraftSnapshot | null {
  const { origin, key } = context(owner);
  const raw = get(key);
  if (raw === null) return null;
  if (bytes(raw) > 800 * 1024) throw new Error("本地草稿异常过大；不会自动恢复或上传。");
  let value: ManualDraft;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("本地草稿损坏；不会自动恢复或上传。");
  }
  if (
    !value ||
    value.version !== 1 ||
    value.owner !== owner ||
    value.origin !== origin ||
    !Number.isSafeInteger(value.updatedAt) ||
    value.updatedAt < 0
  )
    throw new Error("本地草稿账号、站点或版本不匹配，拒绝恢复。");
  validate(value);
  return { raw, value };
}

/** Detect normal stale-tab writes; localStorage check + write is not an atomic cross-tab transaction. */
export function writeManualDraft(owner: string, input: ManualDraftInput, expectedRaw: string | null): ManualDraftSnapshot {
  const { origin, key } = context(owner);
  validate(input);
  if (get(key) !== expectedRaw) throw new Error("本地草稿已被另一页面更改，已停止自动保存。请核对后恢复，避免覆盖。");
  const value: ManualDraft = {
    version: 1,
    owner,
    origin,
    updatedAt: Date.now(),
    text: input.text,
    title: input.title,
    source: input.source,
  };
  const raw = JSON.stringify(value);
  try {
    window.localStorage.setItem(key, raw);
  } catch {
    throw storageError();
  }
  return { raw, value };
}

export function deleteManualDraft(owner: string, expectedRaw: string | null): void {
  const { key } = context(owner);
  if (get(key) !== expectedRaw) throw new Error("草稿已被另一页面更改，未删除。请重新核对当前草稿。");
  try {
    window.localStorage.removeItem(key);
  } catch {
    throw storageError();
  }
}

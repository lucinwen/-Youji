import { combineCELFilters } from "@/lib/cel-filter";
import { buildMemoCreatorFilter } from "@/lib/resource-names";
import { type Memo, Visibility } from "@/types/proto/api/memo_service_pb";

export const SOURCE_KINDS = ["text", "link", "podcast", "conversation", "image", "file"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export type CaptureCategory = "diary" | "work" | "idea" | "reference";
export const CATEGORY_LABELS: Record<CaptureCategory, string> = { diary: "生活", work: "工作", idea: "灵感", reference: "外部材料" };
export const SOURCE_INFO: Record<SourceKind, { label: string; description: string; instruction: string; category: CaptureCategory }> = {
  text: {
    label: "文字片段",
    description: "留住原话，不急着整理",
    instruction: "写一句话也可以。原有编辑器支持附件、录音和可见范围设置。",
    category: "idea",
  },
  link: {
    label: "网页链接",
    description: "网址、选中片段与批注",
    instruction: "只保存你提供的链接和片段，不代表已取得网页全文。原有链接预览仍受实例配置控制。",
    category: "reference",
  },
  podcast: {
    label: "播客片段",
    description: "节目链接与手动时间码",
    instruction: "手动填写时间码与原话。不自动下载节目，也不代表整期已转写或听完。",
    category: "reference",
  },
  conversation: {
    label: "聊天摘录",
    description: "分清他人原话和自己想法",
    instruction: "只粘贴你有权保存的片段；人物和日期不确定时写未知。不连接或读取聊天历史。",
    category: "diary",
  },
  image: {
    label: "照片 / 截图",
    description: "图片、截图与当时的上下文",
    instruction: "在编辑器的＋菜单添加图片或拖入文件。普通上传可能处理图像、移除 EXIF，不保证原始字节不变；本工作台不自动进行 OCR。",
    category: "diary",
  },
  file: {
    label: "音频 / 文档",
    description: "先存材料，再决定怎样用",
    instruction: "在编辑器的＋菜单添加文件。只有保存成功后才形成记录；提取、转写与原件保存是不同状态。",
    category: "work",
  },
};

/** Plain, user-editable provenance. These tags are not an authorization or verification mechanism. */
export function buildCaptureStarter(kind: SourceKind, category: CaptureCategory): string {
  const tags = `#拾微 #${category} #source/${kind}`;
  const source = {
    text: "## 我的原话\n\n",
    link: "## 来源材料\n\n链接：\n\n标题（可选）：\n\n选中片段：\n\n",
    podcast: "## 来源材料\n\n节目链接：\n\n时间码（手动）：\n\n讲者原话 / 我提供的摘录：\n\n",
    conversation: "## 对方的原话或转述\n\n人物（可写未知）：\n\n发生时间（可写未知）：\n\n记录方式（原话 / 转述）：\n\n",
    image: "## 图片与上下文\n\n请通过＋菜单添加所选图片。\n\n发生时间（可写未知）：\n\n",
    file: "## 原始材料\n\n请通过＋菜单添加音频或文档。\n\n材料名称：\n\n作者 / 讲者（可写未知）：\n\n",
  }[kind];
  return `${tags}\n\n${source}## 我的批注（可不填）\n\n`;
}

export function buildSourceFilter(userName: string, category: CaptureCategory | "all", spaceName?: string, search = ""): string {
  if (!userName) throw new Error("A signed-in user is required for the source workspace.");
  return combineCELFilters(
    buildMemoCreatorFilter(userName),
    'tag in ["拾微"]',
    category !== "all" ? `tag in [${JSON.stringify(category)}]` : undefined,
    spaceName ? `space == ${JSON.stringify(spaceName)}` : undefined,
    search.trim() ? `content.contains(${JSON.stringify(search.trim().slice(0, 200))})` : undefined,
  )!;
}

export function getSourceKind(memo: Pick<Memo, "tags">): SourceKind | "unknown" {
  return SOURCE_KINDS.find((kind) => memo.tags.includes(`source/${kind}`)) ?? "unknown";
}

export function getSourceTitle(content: string): string {
  const importedTitle = content.match(/^# 拾微原始资料 · (.+)$/m)?.[1];
  if (importedTitle) return importedTitle.slice(0, 110);
  const candidate = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#") && !line.startsWith("请通过＋菜单") && !/[:：]$/.test(line));
  return candidate?.slice(0, 110) || "一份尚未命名的片段";
}

/** Display server policy, not an inference from source tags or the current view. */
export function getSourceVisibility(visibility: Visibility): string {
  switch (visibility) {
    case Visibility.PRIVATE:
      return "仅自己可见";
    case Visibility.PROTECTED:
      return "实例登录用户可见";
    case Visibility.PUBLIC:
      return "公开范围 · 访客访问取决于实例设置";
    case Visibility.SPACE:
      return "所属空间成员可见";
    default:
      return "可见范围未知 · 请打开记录核对";
  }
}

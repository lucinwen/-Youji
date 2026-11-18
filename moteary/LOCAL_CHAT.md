# 本地聊天 JSON：预览、原件、检索

本入口依据 [Telegram 官方导出格式](https://core.telegram.org/import-export) 独立实现小范围兼容解析。Telegram Desktop 支持[单聊天 JSON 导出](https://telegram.org/blog/export-and-more)；本应用不连接 Telegram 账户、不代为导出、不抓取网址或读取媒体目录。

## 使用

请使用支持 WebCrypto 的 HTTPS 页面或本机 localhost；手机通过普通局域网 HTTP 打开时，安全哈希能力可能不可用，这一路径未验收。

在工作台展开“聊天 JSON 原件与消息正文”，选择具名的单聊天 `.json`，先检查预览、服务事件与媒体计数，再明确确认 PRIVATE 保存。按“聊天”来源与消息中的关键词找回；打开记录后可用消息编号、原始日期对照 ZIP 内的原 JSON。原件不被格式化或改写。

支持：根 `name/type/id/messages`；普通消息 `id/type/date/from/text`；`text` 字符串或字符串与含 `text` 的实体混合数组，按顺序拼接一次，不再拼接 `text_entities`。未知发送者显示“未知发言人”。回复编号仅作文本索引，不自动打开链接。日期保留原导出字符串，不推断时区。所有正文以文本预览和 Markdown 代码围栏保存，不执行 HTML、Markdown 链接或实体 URL。

范围限制：512 KiB JSON、最多 1000 条、解析正文最多 256 KiB，另受账户正文配额限制；超限拒绝而非截断。仅支持具名聊天：缺失/null 名称（如部分 Saved Messages 导出）、全账户导出、`unsupported`/`rich_message` 等未支持消息形态拒绝。服务事件只保留在原 JSON，预览显示计数。媒体、投票、位置和联系信息等不解析或下载；标注相关消息数量，不是完整聊天/媒体迁移。原 JSON 可能包含比预览更多的身份和元数据，保存前检查，原件不做脱敏。没有声称支持微信、WhatsApp、ChatGPT 等其他导出格式。

## 隐私、恢复和删除

预览仅处理用户选中的文件，不访问网络、不写浏览器存储。显式保存才向配置的有记服务器发送正文与原件；不是“所有过程只在本机”。原件与派生文字在同一条 PRIVATE Memo 中，Memos 服务端负责授权。来源哈希用于核验字节，不证明消息真实性。

复用已有单原件上传协议：稳定 ID 绑定账户、原件哈希和文件名；重试先核验原记录的正文、权限、附件归属及原字节，拒绝覆盖编辑。上传响应丢失时查找并逐字节核验未关联原件，保存响应丢失时核验已提交记录。界面显示恢复状态与 ID；刷新后重新选同一原件并确认重试。多个残留候选会停止并提示人工核对，不自动删除未知状态资源；更换文件名或修改导出字节是不同导入，跨其他入口去重未统一。

取消表示停止等待，不保证撤销已提交写入；预览解析 JSON 是有大小上限的同步工作，不能声称中途强制中断 CPU 解析。删除采用原生 Memo 删除和附件核对，不遍历用户正文链接。继承现有客户端账户检查与实际请求之间、附件检查与关联之间的并发竞态边界，没有服务端事务型导入令牌；不宣称多标签并发写入原子性或外部对象存储物理擦除。

## 复用与许可

直接复用 Memos（MIT，来源见 UPSTREAM.json）、既有 fflate 0.8.2（MIT；原 ZIP/校验）和已有 saveAudio 单原件保存实现（本入口不调用 transcribeAudio）。未增加依赖、权重或模型。Telegram Desktop 为 GPL-3.0-or-later；这里只按公开文件格式独立实现，没有复制、链接或分发 Telegram 源码。Readability/Docling 仍是其他来源候选，本入口没有集成它们。

## 验证

只使用合成中英消息、媒体假路径和恶意文本。未验收真实 Telegram 客户端导出文件或多个历史版本，不能声称全面格式兼容。`tests/moteary/run_chat_web_e2e.py` 运行真实 SQLite/HTTP 与实际前端模块，关闭所有可选处理器；模块 RPC 是实际 HTTP 适配，响应丢失为客户端边界故障注入，不是自然断网。检查原件字节、PRIVATE、关键词、重复、编辑冲突、匿名/第二账户读取与删除拒绝、丢响应恢复、重启与最终删除。普通组件测试采用 jsdom，不能当作真浏览器或手机验收。实测证据见 `validation/chat-workspace-20261118/`；本轮不重试此前被拒绝的真人语音评估。

## 无私人数据的演示样本

在独立演示目录生成小型原件（不访问网络）：

```bash
python3 - <<'PY'
import json
from pathlib import Path
source = {'name':'合成项目讨论','type':'personal_chat','id':123,'messages':[
  {'id':1,'type':'message','date':'2026-11-18T10:00:00','from':'合成甲',
   'text':['下周复盘水杉计划 ',{'type':'bold','text':'ChatSourceNeedle'}]},
  {'id':2,'type':'message','date':'2026-11-18T10:01:00','from':'合成乙',
   'reply_to_message_id':1,'text':'同意，请保留原件。'}]}
with Path('synthetic-chat.json').open('x', encoding='utf-8') as target:
    json.dump(source, target, ensure_ascii=False)
PY
```

用 `open('x')` 避免覆盖同名现有文件。选择该文件应看到两条消息，未确认前无保存；确认保存后搜索 `ChatSourceNeedle` 并选择聊天来源，打开记录、下载 ZIP，比对原 JSON。再次选择相同原件应提示已核验；若先编辑已保存正文，重试应提示冲突，不覆盖。把相同文件放入另一账户只能创建其自己的新记录，不能读取第一账户的记录和原件。这些是操作验收步骤；浏览器/手机操作尚未在本环境执行通过。

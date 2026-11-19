# 有记 Youji · 个人生活知识库 Demo

基于完整 Memos 开源应用构建的生活/工作资料采集工作台。当前重点是**多来源原件采集、PRIVATE 保存、重复导入完整性验证**，不是完整 AI 知识生态已完成的声明。

## 入口
- [运行、功能与数据边界](moteary/README.md)
- [批量导入测试与未验证项](moteary/BATCH_QA_20261112.md)
- [正文配额P1与默认隐私修复](moteary/QUOTA_PRIVACY_FIX_20261112.md)
- [中文文本编码与预检](moteary/ENCODING_QA_20261112.md)
- [批量导入核查与回执](moteary/RECEIPT_QA_20261112.md)
- [资料可见范围与搜索空态](moteary/VISIBILITY_QA_20261112.md)
- [关键词检索与实测](moteary/SEARCH_QA_20261112.md)
- [导入隐私与体验改进](moteary/IMPORT_PRIVACY_QA_20261112.md)
- [上游来源和固定提交](moteary/UPSTREAM.json)
- [上游说明](moteary/UPSTREAM_README.md)
- [MIT 许可证](LICENSE)；新增依赖许可位于 `moteary/licenses/`。

## 当前累计草稿与启动

Windows 用户请使用 [PowerShell / WSL 待验证指南](moteary/WINDOWS_DEMO.md)，不要直接粘贴下面的 Bash 命令。Windows 实机尚未验收。

[PR #21](https://github.com/lucinwen/-Youji/pull/21) 的交付分支：`feat/audio-atomic-demo-20261119`。克隆后用 `git rev-parse HEAD` 核对 PR 页面显示的当前 head 提交，不将历史测试源码检查点当作当前 HEAD。此分支包含前序 PR #1–20；不需要逐个合并，也不表示这些草稿已经合并 main。

```bash
git clone --single-branch --branch feat/audio-atomic-demo-20261119 https://github.com/lucinwen/-Youji.git youji-demo
cd youji-demo
git rev-parse HEAD
# 与 PR #21 页面当前 head 提交核对；不一致先停止。
pnpm --dir web install --frozen-lockfile
pnpm --dir web release
mkdir -p build
go build -o build/youji ./cmd/memos
python3 scripts/youji_demo_start.py --binary build/youji --data "$HOME/youji-demos/fresh-demo" --port 5231
python3 scripts/youji_demo_start.py --binary build/youji --data "$HOME/youji-demos/fresh-demo" --port 5231 --run
```

需要 Node 24、pnpm 11.0.1、Go 1.27.2、Python 3；依赖安装可能联网，不是离线安装包。脚本先只打印计划，`--run` 才启动，拒绝覆盖已有非空目录。浏览器打开 `http://127.0.0.1:5231/moteary`，创建合成演示账户。不要提交数据目录、密码、令牌或真实日记。

停止后保留同一数据目录。再次启动已有演示时，不使用“新实例”脚本，而执行：

```bash
env -i LANG=C.UTF-8 "$PWD/build/youji" --addr 127.0.0.1 --port 5231 \
  --data "$HOME/youji-demos/fresh-demo" --driver sqlite --dsn '' --unix-sock '' --config-apply off
```

[完整运行与重启步骤、三分钟合成走查](moteary/DEMO_RUNBOOK.md) · [本地草稿与隐私边界](moteary/LOCAL_DRAFTS.md) · [SQLite 手动文本事务导入](moteary/ATOMIC_MANUAL_IMPORT.md)。默认不启用模型；先用手动粘贴→PRIVATE保存→关键词查回→原件核对。微信仅支持手动提供文本，不是直接接入。

已有 PDF 文本解析、可选语义候选检索、HTML/聊天 JSON 原件导入与音频人工稿等功能，配置及各轮证据见 [功能记录](moteary/README.md)。语义候选可能没有答案；自动语音识别的真人评估保持暂停。真实浏览器、手机、跨设备同步仍未完成验收；组件与 HTTP 测试不能替代这些结论。

前轮 [HTML事务与四来源验收](moteary/HTML_ATOMIC_QA_20261118.md) 记录固定生产构建、并发与检索回源结果；[草稿锁验收](moteary/DRAFT_LOCK_DEMO_QA_20261118.md) 保留前轮证据。真实浏览器与Windows仍未验收。

## 2026-11-12 历史检查点（不代表当前完整范围）
- 已实现：来源类别/批注、完整编辑器、显式单文件和批量 CLI、浏览器批量预检/保存/停止、原件 ZIP 保真、SHA-256 回读、PRIVATE 与修改冲突保护。
- 已运行：33项Python测试；23项真实SQLite/HTTP断言；195文件1647项前端测试；lint/typecheck；生产SPA和完整Go二进制构建。
- **未验收**：新增批量UI的真实浏览器端到端（测试浏览器无法连接执行环境loopback）；Windows/iOS真机；完整离线跨端同步；真实模型、OCR/ASR及语义问答。
- 本仓库为源码交接，不包含数据库、认证凭据、node_modules、二进制或前端生成包；按上面命令重建。
- 基于 Memos 26.11.0 固定提交开发，保留原作者版权，不将完整上游能力冒称自研。上游Go/TypeScript API生成源保留，依赖锁文件保留。

上游自动部署/发布工作流留档在 `moteary/upstream-workflows/`，没有擅自启用自动发布。远端 CI 尚未运行，本地验证结果见报告。

聊天 JSON 的 SQLite 原子保存见 [说明](moteary/CHAT_ATOMIC_IMPORT.md)；[三分钟合成演示卡](moteary/THREE_MINUTE_DEMO.md) 适用于当前配套交付分支，#20 是冻结基准、#19 是历史回退，不要求切回旧版；三分钟尚未计时验证。

本轮 [聊天事务验收](moteary/CHAT_ATOMIC_QA_20261118.md) 给出独立八请求并发结果、固定构建与限制。

当前累计分支的 [音频事务验收](moteary/AUDIO_ATOMIC_QA_20261119.md) 包含独立并发与完整16MiB HTTP测试，以及首次失败和修复证据。#20保持冻结；三分钟操作卡不要求切回旧版。

### Career OS 日期试点

独立草稿分支 `feat/career-event-dates-20261119` 提供可选事件日期、只读采集时间与分页前日期筛选；旧记录的历史时间明确标注。参见 [功能、运行与边界](moteary/CAREER_EVENT_DATES.md) 和 [实现前约定](moteary/CAREER_DATES_PRD.md)。日期里程碑未含来源关系；后续独立分支 `feat/career-private-source-20261119` 增加 [同账户私密来源引用](moteary/CAREER_PRIVATE_SOURCE.md)，以其草稿验收记录为准。

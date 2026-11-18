# 聊天事务与演示候选验收 · 2026-11-18

业务源码检查点 `534653b173ad1b499a433e9f2f765b38c4acf782`；最终生产构建源码（含运行文档更新）`e8fead38b945d1b72b78fd5a0dbff214636c6e48`。版本 `26.11.18-dev.e8fead3`，Linux 二进制 SHA-256 `51dba984c16729af5ffd59021130810028b7fe24d219830a4ab0b553c1a7b53f`。后续证据提交不改变业务源码，GitHub 累计草稿可能使用等价树提交；不要把版本字符串当完整构建认证。未上传二进制、数据库、账号凭据或个人资料。

## 实际通过

- Go API race：Chat/HTML/Manual 共 13/13；前端完整回归 2014 通过、11 跳过；lint、配套前端 release 和 Go build 通过。较早定向 105/105 不与完整集相加。
- 独立编写并运行的聊天 HTTP/SQLite 验收 6/6：8 同时 POST 恰好 1 imported + 7 verified，1 Memo、1 非空 ZIP BLOB、0 未关联附件。验证原件字节、PRIVATE、跨账户/匿名隔离、伪造 owner 拒绝、已有正文变化 409 不覆盖、丢完成响应重试、重启、删除及删除后再重启。
- 实际聊天 TypeScript 模块 + HTTP 3/3；共享 HTML 模块 4/4，手动文本模块 4/4。不是仅 mock API。
- 同一生产二进制的四来源走查 3/3：粘贴、生产 HTML Worker、聊天 JSON、四秒静音音频+人工稿在同一合成账户保存，4/4 原件 ZIP 字节一致，重复核验、各自关键词/来源及共同主题检索、重启后原文与原件读回通过。没有运行 ASR。HTML Worker 在 Node worker_threads 执行，并与二进制实际提供的资产哈希一致，不能当浏览器 Worker 验收。
- 启动/预检 10/10，含真实二进制回环启动、拒绝已有数据目录、匿名访问拒绝；其余是针对预检和计划生成的单元检查。

证据目录：[validation/chat-atomic-demo-20261118](../validation/chat-atomic-demo-20261118/)，总表 [final-summary.json](../validation/chat-atomic-demo-20261118/final-summary.json)。日志保留测试诊断，清除终端控制序列；完整集中的 jsdom scrollBy/scrollTo 未实现消息不代表浏览器通过。

## 可复现命令

先按 [启动手册](DEMO_RUNBOOK.md) 构建配套前后端；以下命令在仓库根运行。使用新的输出目录以保留已有证据。测试启动独立临时 SQLite 实例，只用合成资料。

```bash
go test -race ./server/api -run 'TestYouji(Chat|HTML|Manual)'
pnpm --dir web lint
TZ=UTC pnpm --dir web test --maxWorkers=1
YOUJI_CHAT_ATOMIC_INDEPENDENT_OUTPUT=/tmp/youji-chat-new-independent python3 tests/moteary/run_chat_atomic_independent.py
YOUJI_CHAT_QA_OUTPUT=/tmp/youji-chat-new-module python3 tests/moteary/run_chat_web_e2e.py
YOUJI_MULTISOURCE_QA_OUTPUT=/tmp/youji-multisource-new python3 tests/moteary/run_multisource_demo_e2e.py
YOUJI_HTML_QA_OUTPUT=/tmp/youji-html-new python3 tests/moteary/run_html_web_e2e.py
YOUJI_MANUAL_TEXT_QA_OUTPUT=/tmp/youji-manual-new python3 tests/moteary/run_manual_text_web_e2e.py
YOUJI_DEMO_REAL_BINARY="$PWD/build/youji" python3 -m unittest discover -s tests/moteary -p 'test_demo*.py' -v
```

本轮实际 pnpm 11.25.0，声明版本 11.0.1 未在本轮另测；Go 1.27.2、Node 24.22.1。没有新增依赖、模型或更换上游许可证。

## 阻碍和未测

本轮唯一正常沙箱 Chromium 启动尝试仍在打开应用前失败：`socket() failed: Operation not permitted`，记录为 blocked，未关闭沙箱。真实浏览器、手机、Windows、下载/刷新 UI 和三分钟用户计时均未验收。浏览器尝试针对保留的 PR #19 候选；宿主限制使任何页面未能打开，不冒称新聊天界面已点击验证。真人语音评估继续暂停，没有再次执行。

并发结论只覆盖新版 SQLite 聊天 JSON 专用入口；不覆盖音频/PDF/旧批量、其他数据库或对象存储。丢响应用例是在真实提交后主动丢弃客户端已完成响应，不是实际断网、事务中 kill 或掉电。删除只验证活跃行和 API 不可读，不证明介质/备份擦除。旧版聊天记录可能冲突，保留人工核对，不自动迁移。真实 Telegram 导出兼容、生产压力也未认证。

[三分钟合成演示卡](THREE_MINUTE_DEMO.md) 保留 PR #19 固定提交 `363f4b52fe1fc4914dc447f95ae828850dd06a10` 作为回退；新的累计草稿须完成独立验证后才上传，不合并 main。

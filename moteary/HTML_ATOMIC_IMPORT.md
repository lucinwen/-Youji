# HTML 原件与正文的 SQLite 事务保存

本累计分支保留 PR #18；新 HTML 保存入口为 `/api/youji/html-text/import`。它复用现有 SQLite 原文+原件事务，未修改数据库 schema，不新增依赖。只覆盖新版本地 HTML 导入和对应服务器；音频、PDF、聊天 JSON、批量入口仍在旧保存链路。

用户选择 UTF-8 `.html`/`.htm`（最多512 KiB）→现有 parse5 8.0.1 生产 Worker 提取文字→预览并确认→一次认证 POST 保存 PRIVATE 记录和 ZIP BLOB。Worker 不渲染原 HTML，服务器不解析或执行它、不访问来源 URL。原件中脚本与元数据仍保留；提取预览不是脱敏备份，下载不可信原件后不要直接打开。

固定服务器路由选择 `html-text-v1` 命名空间和上限，不接受客户端 kind、记录ID或附件ID。按当前登录账号、原件SHA、文件名派生 mwh/ymh ID；伪造 owner 拒绝。SQLite 事务内重新核对活跃账号、限额、记录状态/权限/正文和完整原件。并发重复创建只允许一对记录和 ZIP；已有编辑或旧格式不兼容返回409，不覆盖、不自动迁移。原件存入SQLite BLOB，不走配置的对象存储。

HTML原文512 KiB、正文256 KiB，JSON请求上限3 MiB以容纳base64与最坏JSON转义；仍受实际账户正文/数量/存储/上传配额限制。手动TXT入口保留128 KiB及原请求上限，不因HTML扩展而放宽。其他数据库返回501，旧服务器404；前端不回退多请求上传。

取消只停止等待，不保证已经提交的事务撤销。若完成响应丢失，保留相同文件和预览正文重试核验。旧 HTML 记录可能使用不同附件ID或ZIP格式，重试可能409；请打开原记录人工核对，不能把它当自动迁移。旧孤儿附件不由本接口认领/清除。删除仍走原生记录权限及附件关联机制，不声明物理擦除或外部备份删除。

## 同任务走查

本轮固定生产构建的多源脚本使用同一合成账户、共同主题 `SyntheticSharedTopic`，四种来源为手动文字、HTML、单聊天JSON、4秒静音音频+人工稿。每种原文另有独特关键词；分别预览、保存、重复核验、按来源+关键词找回、下载ZIP比较原字节，再重启查回。音频不运行ASR，聊天JSON不连接任何聊天平台；不使用私人资料。

这是实际前端模块与HTTP/SQLite测试。HTML运行同一生产worker资产的Node调度，并核对服务端提供的worker与磁盘文件逐字节一致；不是浏览器Worker验收。脚本单独记录二进制和worker SHA。Windows、真实浏览器、手机、用户操作耗时均未测。旧chat/audio的串行重复通过不能外推并发无孤儿。

按 [演示手册](DEMO_RUNBOOK.md) 构建后，在仓库根目录运行（选新的输出目录）：

```bash
YOUJI_HTML_ATOMIC_QA_OUTPUT=/tmp/youji-html-concurrent python3 tests/moteary/run_html_atomic_e2e.py
YOUJI_HTML_QA_OUTPUT=/tmp/youji-html-module python3 tests/moteary/run_html_web_e2e.py
YOUJI_MULTISOURCE_QA_OUTPUT=/tmp/youji-same-task python3 tests/moteary/run_multisource_demo_e2e.py
```

结果与本轮构建身份见 `validation/html-atomic-demo-20261118/final-summary.json`。默认关闭可选模型，不重试暂停的真人ASR评估。浏览器正常沙箱此前socket权限阻挡，本轮不关闭沙箱，也不把HTTP通过写成真实网页通过。

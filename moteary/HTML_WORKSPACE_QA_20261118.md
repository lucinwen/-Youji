# 本地 HTML 闭环验收（2026-11-18）

基于 PR #13 `7a0f412bd9f8f5ffd89d906bcbabd93ef5525c8e`。独立分支 `feat/offline-html-import-20261118`，初始源码检查点 `398db13422f721c5596d65367cdf5dd2ed06f34e`，最终构建检查点 `524edacb112d85984b4f69c4bc012fe724b698bc`。原分支及 main 未修改；真人语音评估未重试或绕过。

## 实现与审查

复用 parse5 8.0.1 的纯 HTML AST、已有 PRIVATE Memo、ZIP 原件和保存/重试协议。网页只在专用可终止 Worker 提取文字；不创建浏览器文档、不执行原脚本、不加载原资源，输出仅文本。原件可能含未显示的私人元数据和主动内容，确认区明确提示。详细格式、提取策略、许可证和运行步骤见 [LOCAL_HTML.md](LOCAL_HTML.md)。

独立只读审查发现并修复两处问题：复制的聊天文案与 HTML 实际范围不符；表格单元格缺少分隔会把数字拼接。后者加入回归。补齐 parse5 MIT 与 entities BSD-2-Clause 许可证。Worker 终止是资源控制，不是完整网络/内存安全沙箱；静态依赖初始化早于网络 API 覆盖，解析后才做树节点/深度检查。

## 已实际执行的验证

- HTML parser/UI/workspace 定向 51 项通过。其中真实 parse5 18 项，UI 10 项（jsdom 与 mocked worker 生命周期），工作台 23 项；不等于浏览器运行。
- 新目录从源码导出，没有复制 node_modules；冻结锁文件、已有包缓存离线安装（禁用安装脚本）成功，生产前端构建成功。Node 24.22.1 / pnpm 11.25.0，完整日志 `clean-install.log`、`clean-build.log`。不是无缓存冷启动验收。
- 生成 `html.worker-CMvgekDN.js`，165283 字节，SHA-256 `e4d1f1d0f1114b7599031b6b85ba28e44eed87e2bc8e8fba45d6ff8573510cf1`。将该清洁构建产物嵌入 Go；最终二进制 SHA-256 `92fd9dbe3c40ca7230b68ba9832859929263d14d6c1f81887e9693f8488cef3b`。
- 实际执行该生产 Worker 资产：Node worker_threads 仅适配 postMessage/onmessage 调度，解析器没有替换。恶意合成 HTML 包含 script、iframe/srcdoc、img/srcset、CSS @import/url、meta refresh、base、SVG；原资源指向本机探测服务器。3 个实际 Worker，探测请求 0，Worker 启动后的取消得到 AbortError，最后终止并回收。这个结论仅归属 Node 调度与该合成样本，不是浏览器/OS 防火墙证明。
- 实际 HTML 前端模块经真实 HTTP/SQLite：预览无写入、PRIVATE、原 HTML ZIP 逐字节一致、application/zip + attachment + nosniff 响应、链接来源与关键词找回、重复核验、编辑冲突、匿名/其他账户读删拒绝。上传成功后 Memo 未写入、上传已提交但丢响应、Memo 已提交但丢响应均恢复并保持一个逻辑原件。故障注入发生在客户端边界，不冒称物理断网。
- 重启服务后原件及正文一致，最终删除后记录和附件表为空。所有可选处理器关闭，model_executed=false。
- 新数据目录只读预检成功，目标目录未被创建；没有读取或操作用户数据库。

最终全量检查结果见 [final-summary.json](../validation/html-workspace-20261118/final-summary.json)。

## 仍未验证或未承诺

浏览器和真机本轮未重试或验收；此前 Chromium 沙箱 socket EPERM / 云浏览器 loopback 不可达问题尚无解除证据。网页处理的浏览器实际请求观察、移动端软键盘、下载/打开行为仍未验收；jsdom/Node worker 不替代它们。没有真实私人网页或真实站点完整兼容认证。提取可能遗漏、包含非正文、不计算完整 CSS、不 OCR；原件不是脱敏备份。

客户端账户检查和写入之间、附件检查和关联之间仍有竞态，取消保存不保证撤销已提交写入。没有全局去重或外部对象存储物理擦除认证。真实 ASR、微信直接接入未运行或实现。

最终完整前端回归：1865 通过、5 条条件跳过，205 文件通过、3 文件跳过，384.02 秒，退出码 0；新 HTML 的服务条件用例在 HTTP harness 中另行实际通过。类型/格式、清洁安装、生产构建均通过。最终 HTTP 四组检查还验证二进制提供的两份许可证文本逐字节一致。初次清洁安装和最终清洁安装目录均未复制 node_modules，都使用已有离线包缓存；不将缓存安装称为无缓存冷启动。

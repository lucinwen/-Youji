# Moteary 拾微 · 个人生活知识库 Demo

基于完整 Memos 开源应用构建的生活/工作资料采集工作台。当前重点是**多来源原件采集、PRIVATE 保存、重复导入完整性验证**，不是完整 AI 知识生态已完成的声明。

## 入口
- [运行、功能与数据边界](moteary/README.md)
- [批量导入测试与未验证项](moteary/BATCH_QA_20261112.md)
- [中文文本编码与预检](moteary/ENCODING_QA_20261112.md)
- [批量导入核查与回执](moteary/RECEIPT_QA_20261112.md)
- [资料可见范围与搜索空态](moteary/VISIBILITY_QA_20261112.md)
- [关键词检索与实测](moteary/SEARCH_QA_20261112.md)
- [导入隐私与体验改进](moteary/IMPORT_PRIVACY_QA_20261112.md)
- [上游来源和固定提交](moteary/UPSTREAM.json)
- [上游说明](moteary/UPSTREAM_README.md)
- [MIT 许可证](LICENSE)；新增依赖许可位于 `moteary/licenses/`。

## 快速启动

需要 Go 1.27.2、Node 24、仓库 packageManager 声明的 pnpm（11.0.1）：

```sh
cd web
pnpm install --frozen-lockfile
pnpm release
cd ..
go build -buildvcs=false -ldflags "-X github.com/usememos/memos/internal/version.Version=26.11.0" -o build/moteary ./cmd/memos
./build/moteary --addr 127.0.0.1 --port 5231 --data ./demo-data --config-apply off
```

浏览器访问 http://localhost:5231 ，注册本地账号后打开 `/moteary`。不要将本机数据目录、API 令牌或真实日记提交到仓库。

## 2026-11-12 检查点
- 已实现：来源类别/批注、完整编辑器、显式单文件和批量 CLI、浏览器批量预检/保存/停止、原件 ZIP 保真、SHA-256 回读、PRIVATE 与修改冲突保护。
- 已运行：33项Python测试；23项真实SQLite/HTTP断言；195文件1647项前端测试；lint/typecheck；生产SPA和完整Go二进制构建。
- **未验收**：新增批量UI的真实浏览器端到端（测试浏览器无法连接执行环境loopback）；Windows/iOS真机；完整离线跨端同步；真实模型、OCR/ASR及语义问答。
- 本仓库为源码交接，不包含数据库、认证凭据、node_modules、二进制或前端生成包；按上面命令重建。
- 基于 Memos 26.11.0 固定提交开发，保留原作者版权，不将完整上游能力冒称自研。上游Go/TypeScript API生成源保留，依赖锁文件保留。

上游自动部署/发布工作流留档在 `moteary/upstream-workflows/`，没有擅自启用自动发布。远端 CI 尚未运行，本地验证结果见报告。

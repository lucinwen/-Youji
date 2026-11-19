# 固定 #24 Windows / WSL 文档核查

范围：仅修正文档，不改变实现、依赖、PR #24 或 main。

- 源码固定为 `8ef2d5dc40bb9f082ab726b2f7c3478a0a8453de`，远端 PR #24 head 已核对，仍为 open draft。
- 原生 PowerShell 与 WSL Bash 的两条 clone/build 路径均静态断言：分支为 `feat/private-source-picker-20261119`，随后 detached checkout 固定 SHA 并核对，先前端 release 后后端构建。
- 两个 Bash 代码块通过 `bash -n`；README、当前指南、历史存档的相对 Markdown 链接均存在；`git diff --check` 通过。
- 历史存档分隔线之后的文本，与 `git show 8ef2d5dc40bb9f082ab726b2f7c3478a0a8453de:moteary/WINDOWS_DEMO.md` 完全一致。
- 环境无 `pwsh`，未做 PowerShell AST 或执行验证。未执行 Windows、WSL、浏览器、手机验收；未运行模型、监听服务或下载依赖。
- 父线程独立交叉构建报告：离线 Windows amd64 CGO=0 构建在编译前缺少 mousetrap v1.1.0、go-isatty v0.0.24、go-strftime v1.0.0，未产出 EXE。本轮未重复；依赖缺失不等于代码不兼容。
- 指南内列出的普通账户合成 TXT、同名来源选择、ZIP 解压文件哈希和重启检查均是待执行的 Windows/WSL 清单，不是本轮通过结果。

当前指南：[WINDOWS_DEMO.md](WINDOWS_DEMO.md)。旧 #21 原文：[历史存档](WINDOWS_DEMO_PR21_HISTORY.md)。Linux 功能测试来源见固定 #24 的 [QA](https://github.com/lucinwen/-Youji/blob/8ef2d5dc40bb9f082ab726b2f7c3478a0a8453de/moteary/PRIVATE_SOURCE_PICKER_QA_20261119.md)，不外推为 Windows 证据。

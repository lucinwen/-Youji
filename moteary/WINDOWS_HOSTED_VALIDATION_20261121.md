# Windows hosted 验收尝试

基线：PR #26 `8146b2e82ea3f7f70b065fb61f2db244df739ea0`。独立分支 `verify/windows-2025-20261121`，不修改旧草稿或 main。

恢复包原笔记路径不存在，但 `/tmp/youji-acceptance-portability.patch` 与 #26 未提交工作树可读；保留原工作树，独立 worktree 应用补丁。修复 UTF-8 证据读写、Node 输出解码及 Python 子进程编码；拒绝源码内证据目录、已有证据目录和已有构建输出。

本地实际运行：

```bash
PYTHONUTF8=0 PYTHONIOENCODING=utf-8 LC_ALL=C python3 tests/moteary/test_acceptance_portability.py
```

4/4 定向回归通过，4 个 Python 文件 AST 语法检查和 git diff --check 通过。子进程失败传播是受控桩测试，不是 Windows 实测；本轮尚无新 Linux 全链或 Windows 通过声明。

工作流仅该分支 push，标准 windows-2025、contents read、完整 Git 历史且不保留凭据；官方 checkout/setup-go/setup-node/setup-python 固定提交。Go 1.27.2、Node 24、pnpm 11.0.1、Python 3.12；runner temp 放独立 EXE 和证据。40 分钟作业上限，各构建命令 15 分钟上限，测试每组 10 分钟。仅摘要阶段状态及 SHA，不上传原始日志或安装包。

Actions 此前运行数为 0，不据此判断已禁用。远端创建提交不等于 push 事件触发，必须核对 Actions run URL、head SHA 及阶段结论。Windows hosted 构建及 HTTP/模块测试也不等于浏览器、WSL 或用户电脑验收。无 ASR、个人数据、公共监听或仓库设置修改。

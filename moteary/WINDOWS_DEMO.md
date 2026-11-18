# 在 Windows 上启动有记演示

**状态：Windows 原生构建、PowerShell 命令、WSL2 和 Windows 浏览器均未实测。** 本文按当前源码校对参数，提供待验证的操作路径；已有启动、SQLite 和 HTTP 证据来自 Linux，不应写成 Windows 验收通过。默认关闭所有可选解析器／模型，不运行 ASR。

这是基于 Memos 的累计开发分支，不是预编译 Windows 发行包，也不需要合并 main。本文使用累计草稿分支 `feat/chat-atomic-demo-20261118`；先确认该分支已经上传。若下面的查询没有输出，不要改拉 main 冒充最新版本，请等待发布方给出可拉取的累计分支和提交。

## 原生 Windows：PowerShell 路径

使用独立的 PowerShell 终端、普通用户权限。需要事先准备 Git、Node.js 24、pnpm 11.0.1、Go 1.27.2，并确保可从终端运行。本文不安装软件、不修改执行策略。项目声明的 pnpm 是 11.0.1；已有 Linux 构建使用过 11.25.0，不能将其算作 Windows 或声明版本的测试。

SQLite 使用 `modernc.org/sqlite v1.56.0`，不是要求 CGO 的 `mattn/go-sqlite3`。本地驱动文档列出 Windows 386/amd64/arm64，项目也有 Windows 数据目录分支。因此存在原生构建路径，**不能据此保证整个应用已经能在 Windows 编译运行**。以下以 Windows x64 为主要待验证目标；不建议先安装 C 编译器来“修复 SQLite”。

在准备存放源码的新目录执行：

```powershell
git --version
node --version
pnpm.cmd --version
go version

git ls-remote --heads https://github.com/lucinwen/-Youji.git refs/heads/feat/chat-atomic-demo-20261118
# 确认上一条有对应分支 SHA，再执行：
git clone --single-branch --branch feat/chat-atomic-demo-20261118 https://github.com/lucinwen/-Youji.git youji-demo
if ($LASTEXITCODE -ne 0) { throw '克隆失败，请先核对分支是否发布。' }
Set-Location .\youji-demo
git status --short
git rev-parse HEAD

pnpm.cmd --dir web install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw '前端依赖安装失败，停止构建。' }
pnpm.cmd --dir web release
if ($LASTEXITCODE -ne 0) { throw '前端构建失败，停止构建。' }
New-Item -ItemType Directory -Path .\build -Force | Out-Null
$env:CGO_ENABLED = '0'
go build -o .\build\youji.exe ./cmd/memos
if ($LASTEXITCODE -ne 0) { throw 'Windows 构建未通过；保留报错，不要运行旧二进制冒充本次构建。' }
.\build\youji.exe version
Get-FileHash .\build\youji.exe -Algorithm SHA256
```

`pnpm.cmd` 使用 Windows 命令行入口，避免 PowerShell 优先选择 `pnpm.ps1` 的执行策略问题。若安装方式没有该入口，请先检查工具安装，不要禁用系统策略。依赖安装、首次 Go 构建可能联网下载依赖；这不是完全离线安装。

必须先 `pnpm release` 再编译 Go，才会嵌入本次前端。`pnpm build` 的输出目录不同；`scripts/build.sh` 是 shell 脚本，不是 PowerShell 脚本。若使用已经提供的 `.exe`，需确认来源、平台、提交及 SHA，版本字符串本身不能证明前端匹配。

### 首次启动：新目录，不复用已有实例

在上述源码根目录、同一个 PowerShell 终端继续执行。目录放在本机用户的 LocalAppData 下，避免将运行中的 SQLite 数据库放在 OneDrive 或其他同步／共享目录。

```powershell
$YoujiBinary = (Resolve-Path .\build\youji.exe).Path
$YoujiBase = Join-Path $env:LOCALAPPDATA 'YoujiDemos'
$YoujiData = Join-Path $YoujiBase ('demo-' + [guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $YoujiData) { throw '目标已存在，停止；不要覆盖。' }
New-Item -ItemType Directory -Path $YoujiBase -Force | Out-Null
New-Item -ItemType Directory -Path $YoujiData -ErrorAction Stop | Out-Null
Write-Host "请记录并保留数据目录：$YoujiData"

# 只清除本终端进程里的有记处理器和 Memos 配置覆盖，不修改系统环境。
Get-ChildItem Env: | Where-Object { $_.Name -like 'YOUJI_*' -or $_.Name -like 'MEMOS_*' } | ForEach-Object { Remove-Item -LiteralPath ('Env:' + $_.Name) }
& $YoujiBinary --addr=127.0.0.1 --port=5231 --data=$YoujiData --driver=sqlite --dsn= --unix-sock= --config-apply=off
```

此处用 `--dsn=` 和 `--unix-sock=` 的单个参数形式，避免空字符串参数在不同 PowerShell/native 参数传递方式中消失。保留 Windows 必需的系统环境（例如 `SystemRoot`）；这不是隔离沙箱，也不声称清除了全部环境变量。当前 `youji_demo_start.py`／`youji_demo_check.py` 给子进程的环境只有 `LANG`，尚无 Windows 运行证据，**本指南不将它们作为原生 Windows 启动入口**。

保持服务器终端运行，在同一电脑浏览器打开 `http://127.0.0.1:5231`，按首次设置界面创建合成演示账户，然后进入 `http://127.0.0.1:5231/moteary`。第一位账户具有实例管理权限，不要复用真实密码。绑定 loopback 无需向局域网开放端口；不要为此添加公网入站规则。若 5231 已被占用，先正常停止自己的演示服务，或另选端口并同步更改浏览器地址，不要结束不认识的进程。

先走无模型路径：打开“粘贴聊天与文字”，粘贴“合成甲：松涛纸卡Demo，需要两张纸卡，不用投影仪。”，本地预览、确认仅自己可见后保存。搜索 `松涛纸卡Demo`，打开来源、下载 ZIP 核对原文，再测试重复核验和原记录删除。其他来源入口的容量与恢复限制见 [演示手册](DEMO_RUNBOOK.md) 和 [手动文本事务说明](ATOMIC_MANUAL_IMPORT.md)。不要把默认未启用的 PDF／语义／语音处理器当成启动失败；本文不提供启用 ASR 的命令。

### 重启：使用同一份数据库

在服务器终端按 Ctrl-C，等待进程结束。若仍在同一终端，保留 `$YoujiBinary` 和 `$YoujiData` 后重跑上述启动命令即可。**不要重新运行生成 GUID 的首次启动段，否则会创建一个空的新实例。**

若已关闭终端，打开新的 PowerShell，进入原源码目录，再执行：

```powershell
$YoujiBinary = (Resolve-Path .\build\youji.exe).Path
$YoujiData = Read-Host '粘贴首次启动记录的数据目录完整路径'
if (-not (Test-Path -LiteralPath (Join-Path $YoujiData 'memos_prod.db') -PathType Leaf)) { throw '未找到原 SQLite 数据库，停止；不要创建替代空目录。' }
Get-ChildItem Env: | Where-Object { $_.Name -like 'YOUJI_*' -or $_.Name -like 'MEMOS_*' } | ForEach-Object { Remove-Item -LiteralPath ('Env:' + $_.Name) }
& $YoujiBinary --addr=127.0.0.1 --port=5231 --data=$YoujiData --driver=sqlite --dsn= --unix-sock= --config-apply=off
```

重新登录，检查之前的关键词、记录和 ZIP 原件。更新二进制前先停服务并备份完整数据目录；不要同时让两个进程使用这份演示数据。文档不自动删除数据。本地草稿另存于浏览器同源存储，不在 SQLite 目录内；换端口、协议、浏览器或账户可能看不到草稿，不能据此认定服务器数据丢失。

## 已有 WSL2 的替代路径（同样未实测）

如果原生构建或工具链配置受阻，可以考虑在已配置的 WSL2 Linux 发行版里使用 Linux 路径。这是在 Windows 上运行 Linux 服务，不是 Windows 原生验证，也没有在本轮实际启动 WSL2。本文不安装 WSL、不修改系统功能。

在 PowerShell 查看已有发行版：

```powershell
wsl --list --verbose
wsl
```

仅当已进入期望的 WSL2 Linux 发行版，且该环境已准备 Git、Node 24、pnpm 11 和 Go 1.27.2 后，在 **WSL 的 Bash** 中执行：

```bash
cd ~
git clone --single-branch --branch feat/chat-atomic-demo-20261118 https://github.com/lucinwen/-Youji.git youji-demo
cd youji-demo
pnpm --dir web install --frozen-lockfile && pnpm --dir web release
mkdir -p build
go build -o build/youji ./cmd/memos
```

任何一步失败都先停止处理，不使用旧产物。接着按 [Linux 演示手册](DEMO_RUNBOOK.md) 创建独立目录、绑定 loopback 并保留重启路径。使用 WSL 自己的 `~/youji-demo` 和数据目录，不混用 Windows 的 `node_modules`、`.exe` 或运行中的 SQLite 数据目录。Windows 浏览器访问 WSL 服务的 localhost 转发还需在实际机器验证；若不可达，不要直接改为 `0.0.0.0` 或关闭防火墙当作验收通过。

## 核查依据与尚缺证据

- `go.mod` 指定 Go 1.27.2 和 modernc SQLite；本地依赖 `doc.go` 列出 Windows 平台。`internal/profile/profile.go` 具有 Windows 默认路径，并在显式数据目录下建立 `memos_prod.db`；本指南始终传入独立目录，不使用共享默认目录。
- `web/package.json` 定义前端构建及 pnpm 版本，`cmd/memos/main.go` 定义本文的启动参数；没有使用臆造的 Windows 专用开关。
- 本轮在 Linux 只尝试了 `GOOS=windows GOARCH=amd64 CGO_ENABLED=0` 的离线依赖枚举，**未完成**：缓存缺少 `github.com/inconshreveable/mousetrap v1.1.0`、`github.com/mattn/go-isatty v0.0.24`、`github.com/ncruces/go-strftime v1.0.0`，`GOPROXY=off` 拒绝查找。没有安装或下载它们，没有生成或运行 Windows 可执行文件。
- 当前缺少 Windows 构建、首次启动、重启保真、ZIP 下载、正常浏览器及本地草稿恢复证据。Linux HTTP／SQLite 测试不能替代这些项目。

保留仓库 [LICENSE](../LICENSE)、[Memos 来源记录](UPSTREAM.json) 及 `moteary/licenses/` 中的第三方声明；分发构建产物时也应携带对应许可。此指南未引入或复制额外软件实现。

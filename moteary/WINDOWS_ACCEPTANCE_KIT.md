# Windows / Linux 合成验收工具

功能基线固定为 PR #24：`8ef2d5dc40bb9f082ab726b2f7c3478a0a8453de`；工具继承 #25 文档修正。此工具不是 Windows 已通过的声明。原生 Windows、WSL、PowerShell、实际浏览器与手机仍未验收。

## Windows x64 普通账户待执行

已安装 Git、Python 3.11+、Node 24、pnpm（项目声明 11.0.1）和 Go 1.27.2；不需要管理员权限、模型、密钥或公网监听。`--build` 明确允许从依赖仓库安装锁文件依赖；离线机器需事先准备完整可信缓存。不要把旧的离线缺依赖结果说成代码不兼容。

```powershell
$ErrorActionPreference = 'Stop'
git clone --single-branch --branch test/windows-acceptance-kit-20261120 https://github.com/lucinwen/-Youji.git youji-acceptance
if ($LASTEXITCODE -ne 0) { throw 'clone failed' }
Set-Location .\youji-acceptance
$YoujiCommit = git rev-parse HEAD
Write-Host "请与本草稿 PR head 核对源码：$YoujiCommit"
# 确认与 PR head 一致后继续；acceptance.json 会记录实际源码提交。
$YoujiEvidence = Join-Path $env:TEMP ('youji-acceptance-' + [guid]::NewGuid().ToString('N'))
py -3 scripts/youji_acceptance.py --build --output $YoujiEvidence
if ($LASTEXITCODE -ne 0) { throw "验收未通过，保留证据：$YoujiEvidence；不要运行旧 EXE 冒充新构建。" }
Get-Content (Join-Path $YoujiEvidence 'acceptance.json')
```

工具要求干净 checkout 且包含固定 #24 祖先；记录当前 SHA、平台、二进制 SHA256。先 frozen-lockfile 前端安装、release，再 CGO=0 / -mod=readonly 后端构建。任一失败停止，不回退旧二进制。普通依赖安装可能需要网络，验收服务只绑定 127.0.0.1，不启用解析模型。

## 已有 Linux 构建复跑

```bash
python3 scripts/youji_acceptance.py --binary build/youji --output /tmp/youji-acceptance-new
```

输出目录必须全新；不会覆盖既有证据。省略 `--build` 只使用指定可信构建，不声称重新编译过。脚本的功能基线祖先检查不等于当前二进制由该源码编译，须核对报告中的二进制哈希和构建来源。

## 实际执行内容与边界

- 临时合成账户和 SQLite：粘贴文字、本地 HTML、聊天 JSON、4 秒静音 WAV 配人工稿，经实际前端模块保存 PRIVATE；下载 ZIP 并核对解压原件字节和 SHA，重复核验、共同关键词及各来源检索。
- 停止并重新启动同一数据库，重新登录，四份原件与正文、检索结果再次核对。
- 同名“岗位简报”：事件日期消歧，错误版本最后编辑更晚；显式引用正确 ID，改查询与排序、重启后仍保持；打开当前正文。补账户、权限变化、删除中性提示检查。
- 复用来源选择器脚本时前后均使用同一二进制，因此不计为跨版本迁移测试。HTML Worker 用 Node 调度，UI 未经真实浏览器点击；没有语音识别。
- 合成账户密码与 token 不进入汇总。各子测试清理临时服务和数据库，保留脱敏日志；不要以管理员身份执行或向脚本添加私人材料。
- 这不是双击安装包、浏览器验收或 Windows 完整支持认证。实际 Windows 验收另按 [指南](WINDOWS_DEMO.md) 检查正常浏览器首次登录、导入、同名选择、下载及重启。不要为访问失败改成公网监听或关闭安全策略。

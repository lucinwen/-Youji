# 音频原件与人工稿事务验收 · 2026-11-19

冻结 PR #20（`ca965c73968ff9c47f9938b6e45cabffc5c2c7c9`）及 main 未修改。新累计分支 `feat/audio-atomic-demo-20261119` 修正演示卡版本定位、WSL 的 Python 3 依赖，并将音频原件与确认稿件接入 SQLite 事务；没有新增依赖、模型、schema 或修改上游许可。

## 固定构建与实际通过

最终后端源码检查点 `25e41821c5662aa98b1fcbcfe40ca7074cb00606`，前端构建源码检查点 `87afc0d253c1b6abf2a07e92759bb939faf12928`（其后只改网关 Go 代码及测试）。版本 `26.11.19-dev.25e4182`，Linux 二进制 SHA-256 `5213826d815227301ea6bdf3d7c13583f1493042d41ac7d6a41c90594317608e`。后续证据和说明提交不改变业务源码；远端提交可使用等价树，版本字符串不能代替完整构建身份。没有上传二进制、音频文件、数据库或凭据。

- 完整前端 2021 通过、11 跳过；定向 67 通过不与完整集相加。lint、生产前端构建及最终 Go 构建通过。
- 最终 Go race 21/21，涵盖音频/手动/HTML/聊天入口与精确网关上限；早期19/19结果另存。
- 独立真实 HTTP/SQLite 7/7：小型四秒合成 WAV 的8并发恰好1 imported+7 verified，SQLite1 Memo、1 ZIP BLOB、0未关联附件；权限/伪造owner拒绝、修改稿件409不覆盖、丢完成响应重试、重启、删除后重启通过。
- 额外串行 **16 MiB** 有效 PCM WAV 完整 HTTP 保存、PRIVATE ZIP 下载字节及SHA核对、删除404/零行通过；默认账户配额未放宽。原件SHA `6bc0c0aa0ec53a49c87582801be9f5f91f12b838b9891b61ed181ede10b9edf2`。这里只验证归档，不解码、试听或识别。
- 最终固定二进制：实际音频 TypeScript 模块+HTTP 3/3；四来源同账户保存/重复/关键词回源/原ZIP/重启3/3；启动预检10/10（包含真实二进制启动，其余为计划/预检单元测试）。四来源为粘贴、HTML、聊天JSON、静音音频+人工稿；HTML生产Worker通过Node调度，不是浏览器Worker实测。模型明确关闭。

总表：[final-summary.json](../validation/audio-atomic-demo-20261119/final-summary.json)。最终独立证据位于 `validation/audio-atomic-demo-20261119/independent-final/`，模块证据在 `audio-http-final/`、`multisource-final/`。所有素材纯合成；日志只清理终端控制序列及尾部空白，保留诊断。

## 真实发现并修复的问题

初次构建 `0a77dc065480003691e638de66de40471f1649ca16d790dd74ec827b9fde37ab` 的独立检查6组通过，第7组16 MiB POST出现连接重置。原因是自定义路由在认证网关仍套用默认16 MiB请求体上限，内层24 MiB无法扩大它。仅对认证、限流后的精确 `POST /api/youji/audio-original/import` 选择24 MiB；所有其他方法、路径及RPC保持旧上限。修复后更换二进制并复跑，7组全通过；不将初次结果写成通过。

首次失败保留在 `independent/first-attempt-0a77dc06/`；该目录及未带final的模块结果属于初始构建，不能混作最终构建证据。

## 范围与剩余限制

固定服务器路由选择 audio-v1/mwa-/yma-，认证owner、原件SHA及文件名绑定身份。原件ZIP与PRIVATE稿件同事务提交；同原件不同正文或旧附件布局可能409，须打开旧记录核对，不自动迁移、覆盖或清除旧孤儿。其他数据库/旧服务器明确拒绝，不回退分步上传。音频保存只归档指定扩展名字节，不验证可播放性；其他文本入口的UTF-8检查没有放宽。

原件16MiB、请求24MiB、正文256KiB，仍受账户配额；JSON/base64/ZIP不是流式实现，多份缓冲会占内存。本轮8并发仅为小WAV，16MiB为单次串行，不证明大文件并发压力、内存峰值或生产SLA。PDF、旧批量/长文、其他数据库和对象存储事务不在本次修复范围。

浏览器此前受宿主socket权限限制，本轮没有重复尝试，也没有关闭沙箱。真实浏览器/手机/Windows、音频实际播放、用户三分钟用时、自然断网/事务中进程崩溃/掉电、物理介质及备份擦除均未验收。丢响应测试是实际提交后在客户端主动丢弃已完成响应。真人ASR评估继续暂停；未调用任何模型。语音草稿仍需用户主动备份，不声称自动跨端同步。

## 复现

按 [运行手册](DEMO_RUNBOOK.md) 构建配套前后端，使用新的输出目录保存证据；以下只用合成资料和回环临时实例，明确不运行模型。

```bash
go test -race ./server/api -run 'TestRequestBodyLimit|TestYouji(AudioImport|Chat|HTML|Manual)'
pnpm --dir web lint
TZ=UTC pnpm --dir web test --maxWorkers=1
YOUJI_AUDIO_ATOMIC_INDEPENDENT_OUTPUT=/tmp/youji-audio-independent-new python3 tests/moteary/run_audio_atomic_independent.py
YOUJI_AUDIO_RUN_MODEL=0 YOUJI_AUDIO_QA_OUTPUT=/tmp/youji-audio-module-new python3 tests/moteary/run_audio_web_e2e.py
YOUJI_MULTISOURCE_QA_OUTPUT=/tmp/youji-audio-multisource-new python3 tests/moteary/run_multisource_demo_e2e.py
YOUJI_DEMO_REAL_BINARY="$PWD/build/youji" python3 -m unittest discover -s tests/moteary -p 'test_demo*.py' -v
```

实际工具链Node24.22.1、pnpm11.25.0、Go1.27.2；声明pnpm11.0.1未在本轮另测。Windows/WSL说明只做源码核对，原生PowerShell不要求Python；WSL使用Linux预检/启动脚本需要Python3。

[三分钟操作卡](THREE_MINUTE_DEMO.md) 可用于当前配套累计分支，填写实际Git提交与二进制SHA；#20是冻结基准，#19是历史回退，均不是要求先切回旧版。现有#20已验证二进制另存于工作区缓存，固定分支不变。

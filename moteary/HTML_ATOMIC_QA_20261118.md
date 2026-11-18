# HTML 事务保存与固定构建多源走查证据

基线为 PR #18 `cff10c3fa4ed504450c175a2014df574165d70d8`，完整累计分支 `feat/html-atomic-demo-20261118` 保留旧演示分支，不合并 main。业务源码检查点 `bca379f96a05cee705d3f21757137f5ff0a82a32`。

## 本轮实现

HTML入口从共享的附件上传→记录创建流程改为专用认证POST，将原HTML的ZIP与PRIVATE记录放入既有SQLite事务。服务器固定kind/身份命名空间，客户端不能指定记录或附件ID，已有正文/原件冲突拒绝覆盖。原手动TXT端点行为与上限保留；音频、PDF、聊天JSON及批量入口未改。只新增小范围路由配置和复用的有界客户端，不改schema、不新增依赖、不启用模型。

规则及兼容性见 [HTML事务说明](HTML_ATOMIC_IMPORT.md)。旧HTML记录可能因原件格式/附件ID不同而409，不自动迁移。默认单条正文配额8KiB，小于解析器的256KiB文本上限；用户仍受实际账户配额约束，界面和错误提示不承诺所有512KiB网页都能保存。

## 通过与失败证据

- Go API race：8/8（HTML5、原手动3），包含真实gateway和SQLite、PRIVATE/幂等/冲突/伪造kind/owner、请求边界。非SQLite测试仅隐藏可选存储能力的适配器，不是实际MySQL或PostgreSQL。
- 前端定向：93/93，覆盖原手动保存、HTML解析/UI及新端点认证/上限/不回退/未知结果。
- 初次Go测试有测试代码编译错误，随后边界用例先受默认8KiB配额限制，再遇测试配额规则缺少末尾allUsers项；最终仅修正测试配置，默认配额仍按422拒绝，显式合成账号256KiB配额下大请求成功。原失败日志保留，没有修改生产配额以迁就测试。
- 首次lint在并行资源压力下被exit137终止，保留 `initial-lint.log`；之后串行lint通过。已完成的独立QA副本移出内存盘并保留原路径符号链接，没有删除证据或改动其源码。
- 完整前端回归：2004 passed、11 条件 skipped；216 文件（210 passed、6 skipped），402.42秒。相关真实服务条件测试另行运行；其他跳过项不计通过。
- 最终二进制及HTTP结果以 `validation/html-atomic-demo-20261118/final-summary.json` 为准，所有日志使用独立目录。

## 固定生产构建、同一任务

多源验收固定同一个生产二进制，在同一合成账户中保存手动文字、HTML、单聊天JSON和4秒静音音频人工稿。它们共享主题 `SyntheticSharedTopic`，各有独有关键词；分别保存、重复核验、按来源/关键词查回、下载ZIP对原字节、重启查回。HTML生产Worker资产与该二进制实际提供的资产逐字节核对，报告同时记录binary及worker SHA。

这是实际前端模块 + HTTP/SQLite + Node Worker调度，不是生产网页点击。部分RPC为避免触发正常请求预算而节流，不能把脚本耗时当用户用时或吞吐性能。音频为合成静音加人工稿，不是ASR。聊天/音频的串行重复核验不证明它们并发零孤儿。未使用私人聊天、录音、网站会话或外部模型。

## 最终固定构建结果

最终二进制 `26.11.18-dev.bca379f`，SHA-256 `78bae9615f9cc59fc97ee272ed2b2baf9ad09b9b261efd639433c60d7308d315`；HTML Worker SHA-256 `e4d1f1d0f1114b7599031b6b85ba28e44eed87e2bc8e8fba45d6ff8573510cf1`。前端与Go构建通过。

同一二进制下：HTML并发6组、手动文本并发6组、HTML实际前端模块4组、手动文本模块4组、四来源同任务3组、启动检查10项均通过。两种并发路径各8请求，均1 imported+7 verified、1记录/1 ZIP BLOB/0未关联；HTML Worker陷阱请求0，启动后取消成立。四来源原件全部逐字节一致，重启后正文、来源关键词和共同主题找回一致。全部为合成数据、实际HTTP与SQLite，测试结束停止临时服务。

## Windows 与未验收边界

[Windows 指南](WINDOWS_DEMO.md)经过源码参数核查，提供 PowerShell原生和已有WSL2两条路径；没有Windows、PowerShell或WSL实机。离线Windows目标依赖枚举因缓存缺三项依赖被GOPROXY=off阻止，未完成Windows编译、更未运行exe；Linux成功不替代Windows验收。没有下载或安装上述缺失项。环境记录与日志在本轮validation目录。

本轮没有重试已知受阻的浏览器启动，没有关闭沙箱。真实网页、两标签、刷新/崩溃、窄屏/软键盘及手机均未验收。无新同任务竞品测试、不宣称领先。ASR真人评估保持暂停。对象存储、物理擦除、备份、多实例长期压力及真实断网/掉电事务也未验收；丢响应检查是在实际提交后丢弃客户端响应。

## 重复运行

先按 [运行手册](DEMO_RUNBOOK.md) 构建。用新的输出路径，避免覆盖历史证据：

```bash
go test -race -p 1 ./server/api -run 'TestYouji(HTML|Manual)' -count=1 -v
pnpm --dir web lint
TZ=UTC pnpm --dir web test --maxWorkers=1
YOUJI_HTML_ATOMIC_QA_OUTPUT=/tmp/youji-html-concurrent python3 tests/moteary/run_html_atomic_e2e.py
YOUJI_HTML_QA_OUTPUT=/tmp/youji-html-module python3 tests/moteary/run_html_web_e2e.py
YOUJI_MULTISOURCE_QA_OUTPUT=/tmp/youji-same-task python3 tests/moteary/run_multisource_demo_e2e.py
```

Python驱动器启动临时合成SQLite实例并在finally停止；多源脚本不执行构建，要求先构建匹配前端与服务器。没有模型权重或私人数据进入仓库。

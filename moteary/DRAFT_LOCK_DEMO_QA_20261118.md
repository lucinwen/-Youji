# 累计演示分支与草稿写删锁验收

基线：PR #17，`a6e09a0133dff68b10f12c8280e565d356002114`。本轮业务源码检查点：`5f9b270d5ab5c009d7e7592c40a34756871c2d66`。完整累计分支为 `feat/transactional-drafts-demo-20261118`，包含前序 17 条线性提交；不合并 main、不要求逐个 cherry-pick。上传后的固定提交见本轮草稿 PR。

## 改动与适用范围

手动粘贴模式的本地草稿升级为独立 v2 键。同源、同账号的所有新版写入和删除使用同一 Web Locks 独占锁，锁内比较原始快照再修改，且不在比较与修改之间 yield。随机 revision 防止同毫秒相同文本产生相同快照。检测冲突后停止，不覆盖新草稿。没有新增依赖、模型或许可证变更。

界面串行排队；停止保存、卸载、切账号、切到文件模式会取消尚未执行的操作，晚回执不更新新会话。无 Web Locks 时明确拒绝写删，不回退旧协议。旧 v1 草稿只读、显式恢复，不自动迁移或删除；旧标签页继续操作 v1 不影响 v2。它仍是明文同源存储，不是安全保险箱、加密、跨端同步或每次按键必定持久化。

仓库首页和运行手册统一累计分支及构建入口，明确全新实例与保留数据重启的不同命令。三分钟是合成走查目标，不是测得的用户完成时间；主路线为关键词查回，语义只是可选分支。

## 验证分层

- 定向 store/jsdom 控件测试：74/74（35 store、25 draft UI、14 manual UI），由实施代理运行；不等于浏览器。
- 原生 Node 24.22.1 Web Locks：4/4，实际业务 store + 合成同步存储，验证同时写一胜一冲突、排队旧删除保留新文、排队写删取消、冲突后继续写删。显式 `YOUJI_NATIVE_DRAFT_LOCK_QA=1` 运行，默认跳过，不要求所有 Node 24 小版本支持该能力。
- 初次类型检查发现测试 Promise 返回值联合类型错误，已修正，保留 `initial-lint.log`。最终 lint 通过。
- 完整前端回归：1994 passed、10 skipped，214 文件（209 passed、5 skipped），407.35 秒。10 条跳过包括另行启用通过的 4 条原生锁测试，以及需要真实服务条件的用例；实际 HTTP 条件测试另行运行。
- 最终前端/Go 构建通过，二进制 `26.11.18-dev.5f9b270`，SHA-256 `029f32e93b3fbd15edbbde1f783defee2152e2d8dc3045cb57967cde910b1a2f`。
- 同一最终二进制：实际前端模块 + HTTP/SQLite 4 组通过；真实 8 请求并发 6 组检查通过（1 imported + 7 verified，1 memo/1 ZIP BLOB/0 未关联）；最终启动预检 10/10。详情见 `validation/draft-lock-demo-20261118/final-summary.json` 及 `manual-http/`、`concurrent-http/`。

独立原生锁探针发现当前 Node 在同步抛错 callback 后可能保留已占锁；async callback 的独立对照正常释放。生产回调返回 Promise，内部比较与修改仍同步不 yield，最终原生测试验证了冲突后的重新获得锁。原始同步失败与异步对照保留在 `native-runtime-probes/`。这是 Node 运行时观察，不是已复现的浏览器缺陷，也不把适配后的成功倒写成首次全通过。

## 浏览器与运行限制

正常沙箱 Chromium 本轮再次在启动阶段因 `socket() failed: Operation not permitted` 失败；没有关闭沙箱。云浏览器尝试本机演示地址得到 `ERR_CONNECTION_REFUSED`，独立执行命令的同地址探测也未连接成功，不能声称跨工具服务可达。保留 `chromium-startup.json` 和 `cloud-browser.json`。

真实网页点击、刷新、两标签页竞争、390×844 布局、软键盘及手机未验收。Node 原生锁不验证真实浏览器 localStorage、浏览器锁实现或崩溃持久性。普通 HTTP 局域网站点可能没有 Web Locks，需支持的浏览器和 HTTPS/localhost；不可用时保留当前输入并提示自行备份。

启动测试使用新的临时 SQLite 目录，不覆盖旧资料；预检只计划、已有目录拒绝、直接保留同目录重启均有证据。安装依赖未在无缓存全新操作系统重跑，最终构建使用现有依赖；不是离线发行包。真实 HTTP 恢复中的丢响应为客户端在服务提交后注入，非公网断网或进程崩溃。

本轮不修改 PR #17 的服务端事务边界：只有 SQLite 手动粘贴/TXT/Markdown 的原件与记录同事务；音频、PDF、HTML、聊天 JSON、批量旧入口仍可能有并发孤儿。旧原件迁移、对象存储、物理擦除和备份未验收。ASR 真人评估保持暂停，未运行模型。

## 重复执行

在仓库根目录，先按 `DEMO_RUNBOOK.md` 构建，并使用全新的验证输出目录避免覆盖历史证据：

```bash
pnpm --dir web lint
TZ=UTC pnpm --dir web test --maxWorkers=1
YOUJI_NATIVE_DRAFT_LOCK_QA=1 pnpm --dir web exec vitest run tests/moteary-manual-draft-native-locks.test.ts --maxWorkers=1
YOUJI_DEMO_REAL_BINARY="$PWD/build/youji" python3 -m unittest discover -s tests/moteary -p 'test_demo_*.py' -v
YOUJI_MANUAL_TEXT_QA_OUTPUT=/tmp/youji-manual-recheck python3 tests/moteary/run_manual_text_web_e2e.py
YOUJI_MANUAL_ATOMIC_QA_OUTPUT=/tmp/youji-concurrent-recheck python3 tests/moteary/run_manual_atomic_e2e.py
```

上述 HTTP harness 只创建临时合成账户与材料，finally 停止服务；不需要第三方 API 或模型。原生锁测试必须使用提供 native Web Locks 的 Node，未提供时显式失败，不换成 mock 冒充通过。

# 有记浏览器验收准备与导出兼容性修复 · 2026-11-16

本轮基于 PR #3 的 `ee402bd17f3dc1c63dc9b033618f48dbd2133f8f`，独立分支 `test/browser-roundtrip-20261116`。核实 PR #1/#2/#3 仍为 open draft，未合并。没有改 main、认证策略、配额、上游许可证或发布流程。

## 已修复与通过

- 从 `moteary/UPSTREAM.json` 记录的 Memos 上游提交 `b40d8a7b573774c52b022c8d6537d6baf2129dc0` 原样恢复两个遗漏的 MIT 许可导出测试样本。没有用当前实现重新生成黄金样本。
- `core/memoexport/testdata/1.0/golden.zip` SHA256：`5a84a83d79528f068932ef2b367f674807438f078b6028d5a68336afec5605df`。
- `core/memoexport/testdata/1.0/legacy.zip` SHA256：`dcce0e5d83a9cb4e6faefb3efecc2ff7203f4d28563e28a8d5d8047b05a59877`。
- `pnpm release` 生产构建成功，产物不提交。本轮没有再次遇到先前的 SIGKILL。
- `pnpm lint`：681 文件，TypeScript 与 Biome 通过。
- `TZ=UTC pnpm --dir web test --maxWorkers=2`：195 文件通过；1679 项通过，1 项既有环境条件跳过。测试包含 jsdom 的 scrollBy/scrollTo 未实现提示，退出码为 0。
- `pnpm exec vitest run tests/memo-export.test.ts --maxWorkers=1`：7 项通过。
- `GOMAXPROCS=2 go test -p 1 ./core/memoexport -run 'TestGoldenArchives|TestRoundTrip' -count=1 -v`：两个顶层测试及两个黄金样本子测试通过。
- Go 1.27.2，`GOMAXPROCS=2 go build -p 1 -o build/youji ./cmd/memos` 成功；新 SQLite 实例启动成功，loopback HTTP 就绪。
- 日志位于 `validation/browser-checkpoint-20261116/`。仅合成测试和上游测试样本，不含私人材料。

上游原始路径：
- https://github.com/usememos/memos/blob/b40d8a7b573774c52b022c8d6537d6baf2129dc0/core/memoexport/testdata/1.0/golden.zip
- https://github.com/usememos/memos/blob/b40d8a7b573774c52b022c8d6537d6baf2129dc0/core/memoexport/testdata/1.0/legacy.zip

## 失败、未测试与可复现入口

真实浏览器 **未通过验收**。已尝试 Python Playwright 启动 Chromium，在任何应用操作之前失败：`process_singleton_posix.cc:297 socket() failed: Operation not permitted`。使用提供的云浏览器访问隔离实例 `http://127.0.0.1:5231`，也返回 `net::ERR_CONNECTION_REFUSED`。这是环境隔离限制，不是浏览器业务功能已通过或已确定有缺陷。

新增 `scripts/youji_browser_smoke.py` 是待验证的端到端测试入口，已做 Python 语法检查，但浏览器断言尚未执行通过；后续可能需要修正 UI 定位器。不要把脚本存在当作完成证据。正常支持 Chromium 的机器可执行：

```sh
cd web && pnpm install --frozen-lockfile && pnpm release
cd ..
go build -o build/youji ./cmd/memos
# 单独的测试环境安装 Python playwright，并提供 Chromium 可执行文件。
python scripts/youji_browser_smoke.py --binary build/youji \
  --chromium /usr/bin/chromium --output /tmp/youji-browser-evidence
```

脚本创建临时数据库、随机合成密码，仅绑定 loopback；不连接生产数据或模型。设计覆盖浏览器注册、文本和合成静音 WAV 原件导入、预检不写入、复核不重复、回执下载、刷新、正文/批注/文件名检索、点击下载 ZIP 后验证原件、匿名拒绝、另一个 390×844 浏览器上下文登录检索。退出后终止自己的服务并删除临时数据库，只保存结果和合成截图。不包含原生编辑器 17 MiB 上传、音频播放、实体手机、麦克风、ASR 或模型检索测试。

本轮不宣称成熟 Demo。下一步在正常浏览器运行环境执行该入口，补齐原生大音频上传→播放→刷新→下载闭环，修复实际发现的问题，再验证真机与转写。PR #3 的服务端证据仍不能替代这些验收。

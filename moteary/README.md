# Moteary 拾微 · 完整底座集成 Demo

## 当前基线

完整保留 usememos/memos 稳定版 `26.11.0`，固定提交 `b40d8a7b573774c52b022c8d6537d6baf2129dc0`。MIT 版权与许可保留在仓库根目录 LICENSE。不是从零仿写一个低配笔记壳；账户、权限、时间线、Markdown 编辑、附件、搜索、空间、日历、地图、收藏/引用、导出及原生音频录入继续使用上游。依赖另遵守各自许可证。

拾微增量在 `moteary/`、`tests/moteary/` 和前端拾微工作台。完整服务仍然只有一个权威存储。文本、网页 URL、个人批注和原件引用均存入原生 memo/attachment，不另设第二个笔记数据库。

## 本轮可以验收什么

- 启动完整上游 Web + SQLite，而不只展示静态产品图。
- 在工作台保留来源信息、个人批注，交给成熟编辑器保存。
- 导入器接收用户显式指定的单个 Markdown、TXT、JSON、CSV、PDF、图片或音频文件。每一类均保存原附件；可读 UTF-8 文本同时进入可检索正文。
- 默认 PRIVATE，原件 SHA-256、类别、批注参与幂等身份。同一原件的不同用途不会被强制合并。
- 导入未自动发起网页抓取、OCR、转写或模型调用。上游原生 AI 服务存在但需要用户配置，不能算已测 AI。

## 运行

安装仓库声明的 Go 1.27.2、Node 24、pnpm 11.0.1，然后：

```sh
cd web
pnpm install --frozen-lockfile
pnpm release
cd ..
go build -buildvcs=false -ldflags "-X github.com/usememos/memos/internal/version.Version=26.11.0" -o build/moteary ./cmd/memos
./build/moteary --addr 127.0.0.1 --port 5231 --data ./demo-data --config-apply off
```

在浏览器访问 localhost:5231，首次只创建本机测试账户。远程访问须另行配置 HTTPS/身份控制；本 Demo 不擅自公网发布。运行数据不要提交 Git。

## 单文件导入

```sh
python moteary/import_sources.py example.md --kind lecture --note '希望下次演讲时复用' --dry-run
# 本地环境变量 MOTEARY_API_TOKEN 使用该账户自行生成的令牌，勿放进命令行或版本库
python moteary/import_sources.py example.md --kind lecture --note '希望下次演讲时复用'
python -m unittest discover -s tests/moteary -v
```

导入器限单文件 16 MiB；大文件继续走完整产品的原生分块上传。重复导入正常情况下返回 already-imported；原记录已被修改则拒绝覆盖。遇到网络写入结果不确定时保留附件并报告记录 ID，不盲目删除可能已关联的数据。并发重复导入或上传成功而记录写入失败可能留下未关联附件，用户需明确核对后清理。

## 尚未可以宣称的能力

本轮不是原生 Windows/iOS 客户端，也没有实现离线双端编辑合并。响应式浏览器访问同一服务端数据不是端到端加密同步。多输入原件可留存不意味着 PDF/音频内容都已被转写索引。没有配置模型时，语义问答、OCR、ASR、自动归纳不能称已运行。微信系统级导入需要用户导出，不抓取聊天账户。没有私有资料传到第三方，也没有用真实用户数据做演示。

## 数据控制

保留上游权限检查；不设演示绕过令牌。导入器远程 API 只接受 HTTPS，拒绝 URL 中嵌入凭据。本机记录保存与模型出站是不同步骤。未来 AI 派生内容需要独立来源版本/撤权失效治理，当前没有把普通 Markdown 标签冒充强权限边界。

### 已运行验证（2026-11-12）

完整 Go 服务实际编译并连接 SQLite。独立 core 包测试 173 项（含子测试）、9 包通过；链接元数据定向 8 项通过；独立本机 HTTP 合成账户验证 8 断言通过，覆盖中文原文、私有权限、匿名拒绝、进程重启后重新登录读回。

`tests/moteary/run_import_e2e.py` 在一个进程树中启动隔离服务，自动创建随机密码合成账户，校验原件导入、重复导入、PRIVATE、中文原文和附件；不保存认证凭据。运行：

```sh
MOTEARY_BINARY=./build/moteary python tests/moteary/run_import_e2e.py
```

导入重复校验会实际下载原附件核对 SHA-256；已有记录若改为公开、原文被编辑、原附件缺失或被替换则拒绝把它当成一次成功重复。API 重定向一律拒绝，避免凭据离开配置的源。

### 原件字节与预览

独立真实 JPEG 用例发现上游会对图片去 EXIF/重编码。不能把预览声称为原件，也不关闭该隐私保护。拾微导入器将所有文件原字节保存为 `.original.zip` 单文件归档，对可识别图片同时保留一个普通图片预览。回读校验以归档内文件 SHA-256 为准。归档可能包含原始 EXIF，因此始终 PRIVATE；用户主动导出或分享之前应检查原图敏感元数据。所有类型均归档，不根据扩展名判断是否值得保留原件，避免上游嗅探内容后重编码未知扩展名图片。

独立导入验收最终结果：23/23 单元测试（含真实双回环服务重定向凭据隔离）、10/10 完整 Memos/SQLite HTTP 断言。覆盖 Markdown 归档 SHA、中文检索、私有记录及附件匿名拒绝、JPEG 原字节与重复导入、未知扩展名 JPEG 保真、已有 PUBLIC 记录拒绝误报。归档异常成员、路径、损坏与超限解压均拒绝。以上不是 AI 质量或两台真机同步验证。

### 扩展验证的环境失败

`go test ./server/api/...`：`server/api/test` 通过，`server/api` 中 `TestUserWebhookSigningSecretLifecycle` 因沙箱无法 UDP DNS 解析 `example.com` 失败（network is unreachable）。没有修改测试或放宽 Webhook 网络校验来隐藏该结果。`server/auth`、`server/fileserver`、`markdown/...`、`filter/...`、`provider/...` 的测试通过；提供方测试使用测试桩，不证明真实模型可用。

## 显式多资料批量导入（新增，2026-11-12）

用 JSON 清单列出本次愿意导入的文件，不自动扫描目录、不读取微信账号。路径相对清单所在目录解析：

```json
[
  {"file": "日记.txt", "kind": "diary"},
  {"file": "讲座.md", "kind": "lecture", "note": "下次演讲复用"},
  {"file": "录音.mp3", "kind": "conversation"}
]
```

```sh
python moteary/import_batch.py sources.json --dry-run
python moteary/import_batch.py sources.json --receipt receipt-001.json
```

先预检全部输入，再开始上传；默认保持原单文件导入器的 PRIVATE、原件 ZIP 保真与重复完整性验证。清单最多100文件，合计64MiB，单文件仍限16MiB。回执只含文件名、类型、SHA、记录ID和状态，不含正文、批注或认证令牌。每处理一项原子更新回执；遇到失败立即停止，不盲目重试、不清理可能已成功保存的附件。`needs-review` 或 `in-progress` 表示需要检查该记录的实际写入状态，不能当作确定失败。核实后用新的回执路径重跑同一清单，已存在的记录会重新下载并核对原件，而不是仅依赖本地回执跳过。修改后的原记录会被拒绝覆盖。

这是 CLI 多文件流程；浏览器入口已另行接入，见下节；不会自动解析音频/PDF或调用 AI。本轮运行33项Python测试通过，其中10项为新增批处理测试。安装官方 Go 1.27.2 工具链后已重建完整后端，23项真实 SQLite/API 验证全部通过，其中6项覆盖批处理实际写入、私有权限、重跑原件复核和修改冲突停止。未重跑浏览器或Windows，也未连接模型。原QA报告是此前版本的历史结果，不是这一增量的全量认证。源码包不含Git信息，以上构建命令显式设置上游基础版本；不能把此版本号理解为新增功能已经获得上游发布。

## 浏览器批量原件入口（新增界面，2026-11-12）

登录后打开 `/moteary`，在“一次收好一组材料”中选择多个本机文件、共同分类与批注，先点击“预检这批资料”，检查清单后再保存。每次最多32个文件、合计32MiB，单文件16MiB。原件以ZIP保存；文字进入可检索正文，图片/PDF/音频仅归档，不自动OCR/转写。批量入口只创建PRIVATE记录，不加入Space。原来的单片段编辑器保持不变。

队列只在内存中。关闭/刷新后重新选相同文件、分类与批注即可复核；稳定ID包含当前账户，不同账户不会共用同一导入ID。UI与CLI身份格式独立，因此同一文件分别走两个入口会形成两份记录，这不是跨入口去重承诺。重复导入会检查正文与权限，再下载原件校验SHA256。已修改/丢失/校验失败时停止，不覆盖、不删除。用户停止或网络中断时可能有已写入数据或未关联附件，请检查后重试。

新增使用轻量MIT库fflate 0.8.2作浏览器ZIP归档，复用上游认证和Connect API，没有新增代理服务。界面31项定向测试、全量lint/typecheck、生产release已通过；重新构建后端的23项真实SQLite/API验收通过。CUA浏览器无法连接执行进程的loopback服务（ERR_CONNECTION_REFUSED），因此**本轮浏览器端到端尚未验收**，不能把组件测试当成浏览器实测。

## 导入隐私加固检查点

批量队列支持清空并释放本页文件/批注，不删除保存过的记录；账号切换隔离旧队列；原件复核使用有界流读取，用户停止能取消等待读取。详见 [增量说明与浏览器阻碍](IMPORT_PRIVACY_QA_20261112.md)。

## 正文配额与个人采集

浏览器/CLI新建导入前核对账号实际正文配额（默认8192 UTF-8字节，包含标题与批注）。16MiB原件限制不代表可保存16MiB正文。超限直接拒绝且不上传附件，不提高额度或截断原文；长文可手动拆分或以原生编辑器附件保存。个人采集的新草稿默认仅自己，空间草稿默认空间成员；恢复草稿保留原可见范围，请保存前核对。详见QUOTA_PRIVACY_FIX_20261112.md。

长文本显式 CLI 导入与恢复说明：[LONG_TEXT_20261112.md](LONG_TEXT_20261112.md)。网页超限策略保持不变。

网页已新增显式长文模式：[操作与验收边界](LONG_TEXT_UI_20261112.md)。

网页与CLI跨入口冲突处理：[CROSS_ENTRY_GUARD_20261112.md](CROSS_ENTRY_GUARD_20261112.md)。

PDF/音频原件、检索与取回边界：[BINARY_MATERIALS_20261112.md](BINARY_MATERIALS_20261112.md)。

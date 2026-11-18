# 有记本地演示：采集、整理、找回

Windows 原生或 WSL 路径见 [Windows 指南](WINDOWS_DEMO.md)，目前没有 Windows 实机验收。

本指南面向 Linux/macOS 的 Bash 终端，从本仓库当前 checkout 启动独立演示实例。有记直接复用 Memos 应用底座；来源为 Memos 26.11.0、commit `b40d8a7b573774c52b022c8d6537d6baf2129dc0`，MIT 许可证，详见 [UPSTREAM.json](UPSTREAM.json) 和仓库 LICENSE。不要把草稿 PR 当作已经合并的发行版；先记下正在演示的 commit。

默认不启用 PDF 解析、语义检索或语音模型。文本导入、原件保存、人工稿、普通关键词查找不需要模型。自动语音识别的真实验收仍被外连审批阻碍；本指南不提供启用或重跑 ASR 评估的命令。以下演示只使用合成资料。

## 1. 准备程序

本轮可拉取的累计草稿是 `feat/chat-atomic-demo-20261118`，包含 PR #1–19 的前序提交，不需要逐个合并或 cherry-pick。它不是 main 或正式发行版。只在新目录执行：

```bash
git clone --single-branch --branch feat/chat-atomic-demo-20261118 https://github.com/lucinwen/-Youji.git youji-demo
cd youji-demo
```

不要在已有实例的数据目录里构建或启动。查看状态，不覆盖未提交工作：

```bash
git status --short
git rev-parse HEAD
```

构建环境：Node.js 24、pnpm 11.0.1、Go 1.27.2，以及 Python 3（预检及生成合成样本仅使用标准库）。版本来源分别为 `.github/actions/setup-web/action.yml`、`web/package.json`、`go.mod`。

```bash
node --version
pnpm --version
go version
python3 --version
pnpm --dir web install --frozen-lockfile
pnpm --dir web release
mkdir -p build
go build -o build/youji ./cmd/memos
./build/youji version
```

本工作环境实际使用 pnpm 11.25.0，项目声明为 11.0.1；不要将实际验证误称为声明版本的验证。建议记录 `sha256sum build/youji`（macOS 用 `shasum -a 256`）及 Git commit。

依赖安装可能联网；它不是离线安装流程。`pnpm release` 才会把前端写入 `server/frontend/dist`，随后 Go 构建嵌入它。仅运行 `pnpm build` 或 `scripts/build.sh` 不等于更新嵌入前端。没有单独的 `buildFrontend` 命令。若已有同平台、可信来源且包含对应前端的 `build/youji`，可以跳过构建；版本字符串不能单独证明二进制与当前源码完全一致。

## 2. 创建独立演示目录并预检

下面在用户目录下创建随机命名的空目录，不复用任何现有实例。保留终端及输出路径，之后重启要用同一目录。不要把目录、账户凭据、回执或导入文件提交 Git。

```bash
mkdir -p "$HOME/youji-demos"
YOUJI_DEMO_DATA="$(mktemp -d "$HOME/youji-demos/demo.XXXXXXXX")"
YOUJI_DEMO_BINARY="$PWD/build/youji"
printf '演示数据目录：%s\n' "$YOUJI_DEMO_DATA"

# 此演示关闭所有可选本地处理器。
unset YOUJI_AUDIO_PYTHON YOUJI_AUDIO_WORKER YOUJI_AUDIO_MODEL
unset YOUJI_RETRIEVAL_PYTHON YOUJI_RETRIEVAL_WORKER YOUJI_RETRIEVAL_MODEL
unset YOUJI_PDF_PYTHON YOUJI_PDF_WORKER
python3 scripts/youji_demo_check.py --binary "$YOUJI_DEMO_BINARY" --data "$YOUJI_DEMO_DATA"
```

看到 JSON `ok: true` 再继续。脚本不启动服务器、不联系 API、不创建数据目录、不加载模型；只执行你指定的可信二进制 `version` 子命令。它拒绝非空目录和数据目录符号链接，模型环境只显示是否设置，不输出值。它不验证前端完整性、端口占用、可用磁盘量或构建工具版本；不是安全沙箱。已有数据目录被拒绝是保护行为，不要删除其中内容来强行通过。重启既有演示不再使用这个“全新实例”预检。

## 3. 启动并登录

```bash
env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 \
  "$YOUJI_DEMO_BINARY" --addr 127.0.0.1 --port 5231 \
  --data "$YOUJI_DEMO_DATA" --driver sqlite --dsn '' --unix-sock '' --config-apply off
```

保持终端运行，在本机打开 `http://127.0.0.1:5231`。按首次设置界面创建仅供演示的账户；不要复用真实密码。登录后打开 `http://127.0.0.1:5231/moteary`。首次账户拥有实例管理权限。未配置的可选处理器提示不可用是预期行为，不影响人工稿和普通查找。

启动命令使用清理后的环境、loopback、SQLite 和显式新目录；`--config-apply off` 避免自动应用声明式配置。端口被占用时换一个空闲端口并同步修改浏览器地址，不要终止不认识的服务。

## 4. 用合成资料跑通闭环

在另一个终端生成 UTF-8 中文 TXT 和四秒静音 WAV。这里的 WAV 仅验证原件保存与播放器加载，不是语音识别准确度样本：

```bash
YOUJI_DEMO_FIXTURES="$(mktemp -d "${TMPDIR:-/tmp}/youji-fixtures.XXXXXXXX")"
python3 - "$YOUJI_DEMO_FIXTURES" <<'PY'
from pathlib import Path
import sys
import wave
p = Path(sys.argv[1])
(p / '生活日记.txt').write_text('合成演示日记：今天散步时想到水杉计划。DemoLifeNeedle\n', encoding='utf-8')
(p / '工作思考.txt').write_text('合成工作思考：下周把会议记录整理为行动项。DemoWorkNeedle\n', encoding='utf-8')
with wave.open(str(p / '合成静音.wav'), 'wb') as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(16000)
    w.writeframes(b'\0\0' * 16000 * 4)
print(p)
PY
```

1. 展开“批量文字与其他原件”，在“一次收好一组材料”选择两个 TXT，保持普通模式，核对预检及分类，再保存。用 `DemoLifeNeedle`、`DemoWorkNeedle` 查找，打开命中的原记录。来源、类别和日期筛选过窄会隐藏结果，找不到时先清空筛选。
2. 展开“音频原件与校订稿”，选择 `合成静音.wav`，点本机试听；四秒静音应正常结束，无声音是预期。人工稿填写“合成静音文件，仅测试人工稿保存。DemoAudioNeedle”，核对并勾选确认后保存。不要点击自动转写。保存内容仅自己可见，包含原件 ZIP 和人工稿，且明确未使用自动转写。
3. 用 `DemoAudioNeedle` 找回记录，打开原记录、下载 ZIP，解压查看文件名与原始字节。工作台的校验试听只在支持的浏览器/编码上可用；不能把静音 WAV 加载通过外推为所有录音格式通过。
4. 保存前可点击“下载校订草稿 JSON”备份人工稿。文件含敏感正文，不包含音频；刷新后选同一音频，在空白人工稿区域导入备份，再核对并重新勾选确认。草稿恢复不会保存到服务器，也不证明稿件真实性。保存前后保留页面结果，下载恢复回执。回执记录 ID、原件 SHA 和操作状态，不等于所有步骤成功；`upload-unknown`、`save-unknown` 表示结果待核验。重选相同文件并保持同一人工稿可重试；已经人工修改的记录应打开原记录继续编辑，不会静默覆盖。
5. 刷新浏览器，再次查找并下载原件。使用原记录的删除功能删除演示音频记录，再确认关键词找不到、原附件链接不可读取。它只证明 API 可见记录的删除，不证明存储介质、对象存储或备份已物理擦除。历史未关联上传要在附件管理中核对；不要删除不认识的附件。

普通批量入口中 PDF/音频仅归档原件，文件名和批注可检索，内部内容不会自动解析。普通批量每批最多 32 个文件、32 MiB，单文件最多 16 MiB；长文分段模式另有 256 KiB 限制。长文索引与各段是不同记录，删除索引不会连带删除全部分段。当前演示建议用上面的小 TXT 普通模式。

## 5. 可选：已启用的 PDF 入口

默认实例没有 PDF 处理器。若管理员已按 [网页 PDF 工作流](README.md#网页-pdf-工作流2026-11-18基于-pr-7-继续) 安装固定 pypdf 7.1.1 并配置受信 Python/worker，可以在该实例使用“把 PDF 变成可找回的资料”。这不是语音模型，也不是 OCR。上述默认启动命令会清除处理器环境，不会自动继承已有配置。

用仓库 `tests/moteary/fixtures/synthetic-chinese.pdf`：选择文件与分类，点击“本地解析并预览”，核对每页，再保存原件与正文；用“中文检索水杉”及文件来源查找。解析会把 PDF 发送到当前有记服务器；预览不写入记录。上限为 16 MiB、64 页、256 KiB 提取文本；加密、无文本或超限资料不会冒充成功。

清理须先检查清理范围，核对所有记录和未关联附件，并明确确认包括嵌套/归档评论，再执行。删除前停止其他设备编辑；没有跨客户端事务或 CAS 保证。出现变化应重新预览，修改过的记录人工处理。不要把删除索引当成整份导入已删除。

## 6. 重启与手机查看

在服务器终端按 Ctrl-C 等待正常退出，再运行第 3 步同一启动命令，保留同一个 `YOUJI_DEMO_DATA`。重新登录，核对保留的 TXT 正文、关键词和下载原件；不要重新创建目录后误认为旧资料丢失。需要备份时先停服务，完整复制该数据目录到独立备份位置；外部对象存储另行备份。

本指南默认只允许本机连接。先用浏览器开发者工具的窄屏模式检查手机宽度布局；这不等同真机验收。手机上的 `127.0.0.1` 指手机自身，同网访问需要另行配置受信局域网监听、TLS 与访问控制，再使用电脑的局域网地址。普通局域网 HTTP 还可能无法提供 Web Crypto 安全上下文，不能承诺导入功能可用。不要直接把演示端口暴露到公网。手机访问同一服务器不是设备离线同步；断网、后台录音与真实手机浏览器尚须分别验证。

停止演示后保留回执与目录位置。确认所有资料均为不再需要的合成数据后，才由你自行决定是否删除演示目录；本指南和预检脚本不自动清理数据。

## 本地网页与清洁构建复现

网页导入无需模型：选择 UTF-8 HTML、核对纯文本预览后保存。合成样本、资源阻断边界与新目录冻结安装实测见 [LOCAL_HTML.md](LOCAL_HTML.md)。本轮实际使用 pnpm 11.25.0；仓库声明的 11.0.1 不等于本轮已测试版本。原 HTML 只保留在 ZIP，不直接在应用内打开。新版保存要求配套 SQLite 服务器，规则与多源走查见 [HTML 事务保存](HTML_ATOMIC_IMPORT.md)。

## 无模型的首次聊天/日常文本体验

登录后在有记工作台点“粘贴聊天与文字”，按 [手动文本步骤](MANUAL_TEXT.md) 使用合成资料完成预览、PRIVATE 保存、原 ZIP 下载及关键词找回。无需安装解析器或语音模型；这不是微信直接接入。来源/标题可留空，文本限 UTF-8 128 KiB。未保存粘贴内容不自动备份，刷新前自行保留。

## 更短的干净启动入口与本地草稿

准备好可信的 `build/youji` 后，可以用以下脚本替代首次启动的长命令。`--data` 必须是新建或空目录；不带 `--run` 只输出计划且不创建目录。

```bash
python3 scripts/youji_demo_start.py --binary build/youji --data "$HOME/youji-demos/new-demo" --port 5231
# 检查计划后明确启动：
python3 scripts/youji_demo_start.py --binary build/youji --data "$HOME/youji-demos/new-demo" --port 5231 --run
```

它只传 `LANG=C.UTF-8` 给服务，固定 loopback/SQLite，关闭配置自动应用，不继承模型、代理或凭据环境。先选择未用目录；既有目录被拒绝时不要删除内容强行重启。重启已有演示仍按第3步使用同一路径。端口占用不会自动换端口或结束别人的服务。脚本不是OS沙箱，也不会打开浏览器、创建账户或清理数据。

手动入口默认不存本地草稿；可自愿开启明文存储，再明确恢复及删除，详见 [本地草稿](LOCAL_DRAFTS.md)。测试刷新恢复只用合成资料；没有真实浏览器/手机验收时，不把组件重挂载称为浏览器刷新通过。

## 三分钟合成走查目标（不是已测用户用时）

本走查目标约三分钟，仅用于演示排练；目前没有真实浏览器计时，不能写成“用户三分钟完成”或拿接口耗时代替。

1. 计时从点击“粘贴聊天与文字”开始。粘贴下列虚构摘录，来源选“微信聊天（手动提供）”，标题“合成朋友对话”。不要连接微信，不使用私人聊天。

   ```text
   合成甲：周五讨论松涛计划，我会带两张演示纸卡。松涛纸卡Demo
   合成乙：好，不用准备投影仪；我们先看纸卡再讨论。
   ```

2. 点击本地预览，核对否定句“**不用**准备投影仪”和两张纸卡。确认后PRIVATE保存；从回执打开记录，核对原文，没有保存成功就先按错误提示恢复，不另建副本。
3. 换个说法尝试“周五讨论需要准备哪些材料”。只有管理员已经配置并验证语义检索时才使用相近候选，分数不是答案概率，结果可能无关。默认干净实例没有语义模型；看到不可用就明确切换到关键词 `松涛纸卡Demo`。字面检索不支持同义改写时，不编造命中。
4. 打开命中记录，确认确实写着“两张演示纸卡”和“不用准备投影仪”，再核对ZIP内原文。计时终点是打开并核对正确来源，记录是否使用语义、是否回退关键词、是否误点。只有实际操作者走完整条路径后才填写耗时。

当前证据：合成文本PRIVATE、关键词回查、原件字节、权限、重启与重复恢复是**实际HTTP/SQLite及前端模块测试**；草稿开启/确认恢复/账号切换是**jsdom组件测试**；浏览器正常沙箱启动被socket权限阻挡，**真实浏览器完整走查、手机、真实崩溃恢复与用户用时均未测**。语义改写不包含在默认实例的本轮验收中。

与所复用上游Memos的差异仅按源码描述：Memos提供记录、关键词过滤及原编辑器localStorage草稿；本轮在它之上补充手动来源预览、ZIP原文核验、重复恢复、默认关闭的草稿同意/确认/删除入口。没有同任务竞品或上游浏览器计时对照，不宣称优于同类产品。

### 后续同任务对照记录卡（当前均未做竞品实测）

为有记、固定上游 Memos、Joplin 分别使用完全相同的合成聊天（增加改期、地点和否定句）及本地 HTML（含正文、导航、隐藏文本）。一次只测一种来源；不要把在线网页剪藏与本地文件导入混成同一任务。每列填实际操作步数、开始到打开正确原文的耗时、失败原因和证据，不预填胜负。

| 验收项 | 有记真实浏览器 | 固定上游 Memos | Joplin |
| --- | --- | --- | --- |
| 保存文字保真、改期/否定词不丢失 | 未测（已有接口证据） | 未测 | 未测 |
| 刷新后查到正确来源及用时 | 未测 | 未测 | 未测 |
| 原件 SHA-256 一致 | 未测（已有接口证据） | 未测 | 未测 |
| 重复保存、编辑冲突不覆盖 | 未测（已有串行接口证据） | 未测 | 未测 |
| 本地 HTML 正文噪音及隐藏内容边界 | 未测（已有解析模块证据） | 未测 | 未测 |
| 退出、重开与本地草稿恢复 | 未测（已有组件证据） | 未测 | 未测 |

## 手动文本并发修复的适用版本

最新手动文本保存要求配套服务器和SQLite，原件ZIP在SQLite事务内与记录一起提交；旧服务器/其他数据库不回退旧上传。最短新用户步骤及限制见[事务导入](ATOMIC_MANUAL_IMPORT.md)。三分钟主走查直接使用关键词，语义查询仅作为明确可选分支。浏览器真实双标签和用户计时仍未测。

## 9. 固定回退与三分钟演示

[三分钟合成材料演示卡](THREE_MINUTE_DEMO.md) 固定 PR #19 提交 `363f4b52fe1fc4914dc447f95ae828850dd06a10`，该版本仍保留在 `feat/html-atomic-demo-20261118`。回退时在另一新目录克隆该分支并核对 SHA，沿用本指南的工具链与独立数据目录步骤；不要重置正在使用的目录。当前分支新增的聊天 JSON 事务保存范围见 [说明](CHAT_ATOMIC_IMPORT.md)。

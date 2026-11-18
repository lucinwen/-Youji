# 手动文本的 SQLite 事务导入

适用：有记手动粘贴/TXT/Markdown入口，新版前端和新版服务器，SQLite。单原文最多128 KiB，生成正文最多256 KiB，另受账户限制。文件名不能以点或空格开头；预览会提前拒绝。其他数据库返回501，不回退旧上传协议。本轮没有改动音频、PDF、HTML、聊天JSON或批量入口的保存方式。

## 行为

前端主动预览并确认PRIVATE后，只发送一次认证POST `/api/youji/manual-text/import`。服务器按登录账户、原文SHA-256和文件名派生与前端一致的记录ID，生成单文件ZIP，不接受调用方提供的记录/附件ID、可见性、外部URL或存储路径。

SQLite的IMMEDIATE事务内重验活跃账户，核对已有记录及原件，或检查数量/存储/上传配额后一起插入记录和带关联的ZIP BLOB。新原件明确存入SQLite数据库，不使用本地文件或对象存储流水线；管理员配置的外部附件后端不参与这个专用入口。新界面返回imported或verified。正文限额也在请求预检中检查；管理员降低正文限额后，既有记录核验可能被拒绝，应打开已有记录核对或调整配额，不能保证所有重试成功。已有正文、权限、空间、状态、原件等不一致返回409，绝不覆盖。

这条事务仅包括该SQLite数据库的记录、附件字节及关联。没有外部对象存储提交，也不派发webhook或提及通知；只发送实例内的记录变化通知。它不是涵盖网页、通知、跨数据库或全站操作的分布式事务。限额设置在事务前读取；其他旧入口的非事务限额与写入行为不因此改变。不是生产就绪声明。

若客户端丢失已提交响应，结果保持待核验，重试相同原文/标题/来源即可核验既有一对记录；取消请求不保证已提交事务撤销。已有非新版事务创建的手动记录可能使用不同ZIP格式/附件ID/存储方式，重试会提示旧版不兼容：直接打开原记录人工核对，不自动迁移、覆盖或新建。既有记录仍可照常读取、下载、编辑。

旧协议留下的孤儿不被这条接口认领或自动删除。其他来源的并发双上传风险仍然存在。本会话所有已知附件ID继续显示；它们不是完整孤儿清单，刷新前自行保留。

## 最短新用户路径

这是源码草稿，不是预编译发行包。先准备 `DEMO_RUNBOOK.md` 列出的Node/pnpm/Go/Python，再在新目录拉取本轮完整分支：

```bash
git clone --single-branch --branch feat/atomic-manual-import-20261118 https://github.com/lucinwen/-Youji.git youji-demo
cd youji-demo
pnpm --dir web install --frozen-lockfile
pnpm --dir web release
mkdir -p build
go build -o build/youji ./cmd/memos
```

构建时间不计入三分钟走查目标；安装依赖可能联网，版本要求见运行手册。随后检查并明确启动新的合成演示实例：

```bash
python3 scripts/youji_demo_start.py --binary build/youji --data "$HOME/youji-demos/fresh-atomic" --port 5231
python3 scripts/youji_demo_start.py --binary build/youji --data "$HOME/youji-demos/fresh-atomic" --port 5231 --run
```

脚本默认仅计划，第二条才启动；已有非空数据目录会被拒绝而非覆盖。浏览器打开 `http://127.0.0.1:5231/moteary`，创建演示账户，粘贴手册的虚构微信摘录，预览并确认保存，用 `松涛纸卡Demo` 关键词查回原文，再下载ZIP核对。语义找回为明确可选分支，未配置则用关键词。三分钟是排练目标，不是已测用时；不接入微信，不用私人资料或语音模型。

## 保留数据重启

上面的 `youji_demo_start.py --run` 只适用于全新/空目录；它拒绝已有数据是保护行为。正常停止后，不要删除 `fresh-atomic` 目录，也不要再次运行“新实例”脚本。仍在仓库根目录时，使用同一二进制和同一目录重启：

```bash
env -i LANG=C.UTF-8 "$PWD/build/youji" \
  --addr 127.0.0.1 --port 5231 \
  --data "$HOME/youji-demos/fresh-atomic" --driver sqlite --dsn '' \
  --unix-sock '' --config-apply off
```

重新登录原演示账号，按同一关键词找回并核对原件。若首次启动选了不同目录或端口，重启也必须使用相同值。这条命令不会启用可选模型。

## 验收边界

数据库单测包含并发、冲突、账户、限额与故障回滚；真实HTTP并发结果另见本轮QA报告。浏览器双标签实际操作和手机仍未验收；此前正常沙箱Chromium被socket权限阻挡，未关闭沙箱。数据库及HTTP并发不能冒充浏览器验收。物理擦除、备份、对象存储、多数据库、多实例长期压力不在本轮通过范围。

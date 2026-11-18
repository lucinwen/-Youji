# 离线导入本地 HTML：提取文字与原件回溯

本轮直接使用 [parse5](https://github.com/inikulin/parse5) 8.0.1（MIT）解析 HTML 语法树；使用已有 Memos 私有记录、fflate ZIP 和单原件保存/核验/重试机制。parse5 此前是 jsdom 的间接开发依赖，本轮固定为直接运行依赖，锁文件没有升级其他包。其 entities 8.0.0 依赖为 BSD-2-Clause，完整许可证均在 [licenses](licenses)，并放入 `web/public/licenses/` 随前端和嵌入二进制提供；分发时请保留。未复制其他产品代码。Mozilla Readability 是已评估但未接入的 Apache-2.0 候选；本实现不是它的智能正文识别，也不是 AI 摘要或 OCR。

## 操作与范围

用支持 WebCrypto、模块 Worker 的 HTTPS 或 localhost 页面打开有记，在工作台展开“本地网页原件与提取文字”。选择 UTF-8 `.html/.htm` 文件，查看提取文字、标题、作者、原文件名和来源信息，确认后才保存到配置的有记服务器。选择“链接”来源并按正文关键词找回；打开记录后下载 ZIP，内含原 HTML 完整字节及可核验 SHA-256。原文件内容不重写。

输入最多 512 KiB；解析后的树最多 10000 节点、深度 128；文字及最终记录最多 256 KiB，另受账户配额限制。仅支持严格 UTF-8，不猜测其他编码。选择首个可见 `article`，否则首个 `main`，否则 `body`；过滤 script/style/noscript/template/iframe/object/embed/SVG/MathML/form/输入控件/nav/aside/footer 等节点及显式 hidden、aria-hidden、部分内联隐藏样式。表格单元格用换行分隔，避免把相邻数字拼成另一数字。不计算完整 CSS，也不解析图片、外部媒体或脚本生成的正文，可能遗漏或夹带非正文；需要人工核对。空结果、超限或失败不生成假正文、不自动上传。

标题与作者最多保留 512 字符的预览元数据；canonical 来源只提取不超过 2048 字符的绝对 HTTP(S) 字符串，不解析 base、不访问网址、不认证归属，其他情况显示未提取。完整原值仍在原 HTML。此入口不是全站归档、完整视觉网页备份或事实真实性证明。

## 安全与隐私边界

- 输入只交给 parse5 的普通 AST，不调用 DOMParser、不把原 HTML 挂载进浏览器 DOM、不执行 script、不创建 iframe/image 等资源元素。预览用 React 文本节点，保存文字用足够长的 Markdown 代码围栏；源链接也仅作为文本。
- 解析在专用 Worker 中，主线程 5 秒超时和取消均终止该 Worker。覆盖 fetch/XMLHttpRequest/WebSocket/EventSource/importScripts 为拒绝属于纵深防御；不是 OS 级出站隔离或完整安全沙箱。静态依赖先初始化，节点/深度检查在 parse5 完成后执行；输入上限与超时不等于严格峰值内存限额。
- “离线解析”表示文件解析不访问原站或第三方服务。首次访问有记、加载同源 Worker 资产、查询记录及确认后的持久化仍涉及你配置的有记服务器，不保证在未缓存应用时断网可启动。
- 保存必须明确确认；原 HTML 中未显示的脚本、外链、身份信息和元数据也会随原件上传，预览不是脱敏流程。只用 PRIVATE 记录与鉴权 ZIP 下载，不提供同源原 HTML 内联展示。下载不可信原 HTML 后不要直接打开它。
- 一份来源存为一条 Memo 和一个原件 ZIP。重试核验所有者、权限、正文和原始字节；用户编辑后拒绝覆盖。上传或写入响应丢失可查找/核验已有资源，多个未关联候选停止并提示人工核对，不盲删。取消保存仅停止等待，不能保证撤销已提交写入。刷新后重新选择同一文件可重试；没有浏览器自动持久化草稿。
- 沿用已有检查与写入之间的并发竞态边界，没有服务端事务型导入令牌；不同文件名/字节或其他入口不保证全局去重。原生删除及附件表检查不代表外部备份或对象存储物理擦除已认证。

## 构建与干净目录复现

沿用 [演示运行手册](DEMO_RUNBOOK.md)，默认关闭所有模型。从指定草稿分支构建，不把 main 当作已包含新功能。必须先 `pnpm --dir web release`，再构建 Go，才能把 Worker 及新前端嵌入服务。

本轮实测工具：Node 24.22.1、pnpm 11.25.0、Go 1.27.2。仓库 packageManager 声明仍为 pnpm 11.0.1；本轮没有将“声明版本”当成实际测试版本。

实际清洁安装验证：将源码检查点的 `web/` 导出到全新目录，没有复制 node_modules，然后使用现有 `/workspace/.pnpm-store` 缓存执行：

```bash
pnpm --dir NEW_DIRECTORY/web install --offline --frozen-lockfile --ignore-scripts --store-dir /workspace/.pnpm-store
RAYON_NUM_THREADS=1 NODE_OPTIONS=--max-old-space-size=1024 pnpm --dir NEW_DIRECTORY/web release
```

这验证了冻结锁文件与新依赖树能重建，不是无缓存新机器的离线安装证明。普通新机器第一次安装需要获取锁定依赖；不要把这里的缓存路径当成通用系统路径。测试与构建尽量串行；低内存主机可能失败。生产 Worker 文件 `html.worker-*.js` 应在 `server/frontend/dist/assets/`，不能只验证入口页面存在。

启动时使用新建空数据目录，运行只读预检，再按手册显式关闭可选处理器。HTML 不需要 Python PDF/ASR/检索模型。源码验收脚本 `python3 tests/moteary/run_html_web_e2e.py` 需要已构建二进制、Worker 资产及前端测试依赖；它创建合成账户与临时 SQLite，结束停止服务，不使用现有用户数据库。

## 无私人资料的样本

在独立演示目录运行，已有同名文件会拒绝覆盖：

```bash
python3 - <<'PY'
from pathlib import Path
with Path('synthetic-page.html').open('x', encoding='utf-8') as f:
    f.write('<!doctype html><meta charset="utf-8"><title>合成水杉计划</title>'
            '<meta name="author" content="合成作者"><article><h1>工作灵感</h1>'
            '<p>HTMLSourceNeedle：下一次讨论先核对原始资料，再整理行动。</p></article>')
PY
```

确认预览未写入；保存后按 `HTMLSourceNeedle` 和“链接”来源找到记录，下载原件核对字节。再次选同一原件应核验而不新增；编辑已保存正文后重试应提示冲突。删除后核对记录、附件与检索。真实手机、浏览器点击/下载及浏览器 Worker 外联观察仍未验收，不能用 Node Worker 或 jsdom 通过替代。微信等直接接入未实现；当前工作不改变其优先级，也不把通用文字导入说成平台接入。

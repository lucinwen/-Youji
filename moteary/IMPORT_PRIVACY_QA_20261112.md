# 导入体验与隐私增量 · 2026-11-12

## 本次改变
1. 原件重复验证由一次性 `arrayBuffer()` 改为有界流读取。服务端漏报或虚报 Content-Length 时，实际内容仍限17MiB，超限取消读取；用户停止会取消阻塞中的读取。
2. 批量预检列表显示每份原件大小；提供“清空本页队列”，清除待处理文件引用、批注和状态，不删除已有记录。
3. 批量组件以当前账户标识作为 key，切换账号会卸载旧队列并取消进行中的上传，避免把旧账户队列带入新会话。

## 已运行
- 12项导入定向前端测试通过（新增5项）：分块原件保真、过大声明拒绝、虚假小声明的实际超大流停止、用户取消阻塞读取、清空队列不写入或删除服务端资料。
- Python33项通过；完整Go服务+临时SQLite的23项真实API断言通过。
- lint/TypeScript检查681文件通过；生产SPA release及Go嵌入构建通过。

## 真实浏览器验收阻碍
新增 `tests/moteary/run_browser_batch_qa.py`，只使用临时合成账号与文件，启动同环境服务，以避免之前CUA浏览器无法连接loopback的问题。
但本环境Chromium在启动阶段失败：`process_singleton_posix.cc socket() failed: Operation not permitted`。通过执行权限复核的同一尝试仍失败，因此未执行浏览器断言、没有生成成功截图。未绕过系统限制，未改为公网服务。

在支持Chromium的本地开发环境可运行：
```sh
# 先按README编译，安装官方 Python Playwright，设置本机浏览器可执行路径
CHROMIUM_PATH=/usr/bin/chromium python tests/moteary/run_browser_batch_qa.py
```
脚本会保留不含令牌的逐项结果、失败类型；临时数据库和合成资料结束后清理。脚本本身还未完成端到端运行，不是已验收承诺。

本次没有真实用户日记、模型出站、OCR/ASR或Windows/移动端验收。

全量前端回归：195文件、1652项测试全部通过（UTC、single worker，275.23秒）。jsdom scrollBy/scrollTo未实现警告仍存在，不视为浏览器实测。

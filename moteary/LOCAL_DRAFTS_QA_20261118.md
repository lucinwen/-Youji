# 本地草稿与干净启动验收（2026-11-18）

基线 PR #15：`41162cfb7eec18c208764d3443bd7d1efa3104b9`。只使用合成资料，不连接微信、不执行模型。

实现与边界见 [LOCAL_DRAFTS.md](LOCAL_DRAFTS.md)。Memos 原草稿机制已通过源码核查；本轮新入口独立命名空间，默认关闭持久化，不假称加密、物理设备隔离或跨端同步。

## 分层证据

- localStorage 模块定向：29/29，通过账户/站点/版本校验、异常/容量/损坏、读后比较写入与删除。不宣称原子 CAS。
- 干净启动：Python 10/10（含原预检6项、新启动4项）。真实可信服务先只显示计划且不创建目录，再显式启动loopback实例，GET工作台200、匿名API401，结束后拒绝重用非空目录。最终构建后再复核。
- 实际浏览器启动：blocked。正常 Chromium sandbox 开启、独立profile、仅about:blank，socket() Operation not permitted退出；`browser-startup.json`保留错误。未使用--no-sandbox，未重试或绕过。不算实际浏览器刷新/崩溃/手机验收。

- 新草稿jsdom交互19/19，原手动入口交互14/14；真实localStorage模拟重挂载、恢复确认、账号切换、错误及保留多回执。不是浏览器刷新或崩溃验收。
- 完整前端：1960 passed / 6 skipped，209文件通过、4条件文件跳过，445.20秒；新增HTTP条件用例将另在真实服务执行。
- 完整lint通过。开发中途检查曾仅报告尚未格式化的UI，保留lint-in-progress-format.log；冻结后lint.log通过。
- 业务源码检查点：`7c857f117b132f9451e14553d15f44afb8348b18`。后续仅补运行手册及验收证据。

## 残留问题

- localStorage明文，同源脚本或共用browser profile可访问；账号区分是应用命名空间和界面约束，不是认证安全保险箱。
- storage事件与比对不等于跨标签页原子事务；避免同时编辑。只能恢复最后成功写入版本，不保证崩溃前所有按键持久化。
- 服务端公共saveAudio仍可能在并发双上传时留下未关联附件。本轮保留所有已知回执，不自动删除未知对象；未实现服务端幂等分配/写入事务，不能称并发零重复。
- 账号切换UI与服务请求之间原有竞态未泛化为原子保护；服务端仍执行权限校验。
- 清除浏览器草稿不证明介质物理擦除或系统备份清除；服务端记录不受本地删除影响。
- 真人ASR评估继续暂停，未尝试被拒绝操作或替代模型。

用户要求的三分钟走查已写入DEMO_RUNBOOK，明确是排练目标。没有实际操作者浏览器计时；不把HTTP测试时长当用户找到正确来源的用时，不声称竞品胜出。

## 最终构建与服务验收

前端release构建通过（20.83秒，保留既有大chunk提示），Go构建通过。二进制SHA-256：`caa35d155c97094cf029a9dc82fcee99131b8b603640d601479ffae015d509d4`，业务源码检查点如上；依赖/模型/二进制未纳入提交。

`YOUJI_MANUAL_TEXT_QA_OUTPUT=validation/local-drafts-20261118 python tests/moteary/run_manual_text_web_e2e.py`退出0：四组真实HTTP/SQLite通过，实际TS模块条件测试1/1（73.89秒）。其中本地存储由jsdom提供：从草稿恢复同一文字后重复提交得到verified；服务端实际PRIVATE、原ZIP字节、关键词、权限、冲突、注入丢响应、重启及删除均核验。该时长是测试运行时长，不是用户完成任务用时。

`YOUJI_DEMO_REAL_BINARY=build/youji python -m unittest discover -s tests/moteary -p 'test_demo*.py' -v`用最终二进制复跑10/10通过。日志`demo-start-final.log`。先前`demo-start.log`使用PR15二进制进行开发预检，不冒称最终构建证据。所有临时服务在finally停止。

首次lint在UI开发中只报格式问题，冻结后通过；无隐藏业务失败。浏览器启动失败保留为blocked，不调用禁用沙箱的替代路径。将已完成PR15独立QA目录移出/tmp内存盘且保留原路径符号链接，未删证据。

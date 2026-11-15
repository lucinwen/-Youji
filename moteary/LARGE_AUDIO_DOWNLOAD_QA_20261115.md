# 长录音下载与导出接口补验

前一轮 `TestYoujiLargeAudioOriginal` 只直接读取落盘文件校验 SHA256，不能算下载/导出已验收。

本轮新增 `TestYoujiLargeAudioHTTPDownloadAndExport`：使用独立 SQLite、临时存储与合成有效 17 MiB PCM WAV，通过产品真实分块服务上传并关联 PRIVATE 笔记；随后启动实际 loopback HTTP 测试服务器，调用产品真实文件路由，没有模拟下载或导出处理器。

实际通过：
- 已认证用户 GET `/file/attachments/.../synthetic-long.wav`：200，完整长度与 SHA256 一致，Cache-Control 为 private,no-store。
- 匿名同一路由：401，没有原件泄漏。
- 已认证 Range 请求 bytes=100-999：206，返回准确900字节，并有 Content-Range。
- 普通成员请求自己的整库 `/file/users/.../export`：403。**现有上游整库导出只允许管理员，并非所有普通用户都能自行整库导出。**
- 管理员请求该用户整库导出：200，解开真实返回ZIP，恰有一份与录音原件 SHA256 完全一致的17 MiB文件。

命令：`GOMAXPROCS=2 go test -p 1 ./server/fileserver -run TestYoujiLargeAudioHTTPDownloadAndExport -count=1 -v`。1个集成测试通过，日志见 `validation/large-audio-http-20261115.log`。`git diff --check`通过。

边界：上传部分直接调用真实服务方法，下载/导出部分使用真实HTTP网络及真实路由；没有浏览器点击、外网、移动端、长时间音频播放或ASR测试。没有更改认证或导出权限。单条附件下载可用，不意味着普通成员具备整库迁出体验。此项产品权限差距应纳入后续设计，而不是以本次管理员导出成功掩盖。

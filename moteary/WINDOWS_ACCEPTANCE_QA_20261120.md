# Windows 验收工具：本轮实际证据

实现检查点 `f879c7dcb2204416c73b9ef7a4d7be17ad1cd0ef`。运行命令：

```bash
python3 scripts/youji_acceptance.py --binary build/youji --output /tmp/youji-acceptance-20261120
```

Linux Python 3.12.14 实际通过：多来源 3 组（含四种材料原件保真与重启），来源选择器 6 组（同名日期消歧、固定 ID、当前正文、权限与删除）。使用已有 #24 二进制，SHA256 `8b5d56a700ac8ba9c31be4ff0d8acd551c4ce1fbf128ee50d4298e3c52094d83`，本轮未独立重建。没有遗留 youji 子服务。

汇总及子报告保存于 [validation/windows-kit-20261120](../validation/windows-kit-20261120)。该报告绑定测试时的本地检查点；发布时 GitHub 连接器可能使用不同提交元数据，发布核对源码树一致性。后续只增加文档/证据不重写该结果。

额外实际验证：`--help` 成功；同一已存在输出目录再次运行返回 2 且拒绝覆盖。`git diff --check` 通过。原有来源选择器测试用同一构建前后启动，不代表旧版本迁移。

未执行：`--build`、Windows EXE、PowerShell、WSL、浏览器、手机、ASR。本轮没有尝试再次离线交叉编译或下载依赖。Windows 构建缺依赖的问题未因本工具自动消失；需在授权 Windows 环境准备锁定依赖再运行。工具提供可复现步骤和证据格式，不能据此称 Windows 已支持或验收通过。

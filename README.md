# Clash 订阅管理器

Windows x64 独立配置工作台。来源、固定节点、场景、策略和分流规则统一维护，明确应用到 Clash Verge 的一个「订阅聚合」入口。Clash Verge 继续管理代理内核、TUN 和系统代理。

- 用户入口：[使用说明](docs/subscription-manager.md)。
- 行为约定：[规格](docs/specs/subscription-manager.md)、[设计](docs/design/subscription-manager-plan.md)、[领域词汇](GLOSSARY.md)。
- 源码：`src/core/` 为无 Electron 依赖的领域实现，`src/desktop/` 为受限 IPC 与进程生命周期，`src/renderer/` 为 React 编辑器，`native/` 为 Windows 进程、互斥与计划任务适配。
- 核心测试通过与界面相同的 `Manager.execute(Command)` 入口；稳定池沿用 `StabilitySession` 与 `MonitorRunner` 行为接口。替身仅用于进程、时钟、下载、控制器及远端边界。

## 开发

从本目录用 PowerShell 7 执行；开发需要 Node.js 24 或更新版本和 npm。正式软件随 Electron 交付运行环境，不使用 Python 后端。

```powershell
npm ci
npm run typecheck
npm run test:file -- test/workspace.test.ts
npm run prepare-runtime
npm run build
npm start
```

`prepare-runtime` 校验官方 MinGit 压缩包的大小和 SHA-256，再解压到忽略的资源目录；Windows 辅助程序使用系统 .NET Framework 编译器构建。不读取真实订阅配置，不向设备安装开发工具。首次构建需要联网下载资源，后续复用已验证副本。

```powershell
npm run package
```

产物：`release/ClashManager-0.1.0-win-x64.zip`。发行包包含 Chromium、Node.js、MinGit 和本机辅助程序；不是需要源码仓库才能启动的脚本入口。`node_modules/`、`dist/`、`release/`、生成的 `resources/bin/` 不入库。

## 验证

```powershell
npm run typecheck
npm test
node scripts/test-mihomo.mjs
```

常规测试在仓库 `tmp/clash-manager-tests/` 创建脱敏设备和临时 Git 远端，不读取 `.env`，不修改活动客户端。可选隔离测试用本机辅助程序只读发现已安装的 Mihomo，启动本轮专属子进程和回环控制器，关闭 TUN、DNS 监听与代理端口，结束时只停止自己创建的子进程。它验证配置加载、规则出口与 provider 凭据刷新，不验证外部网站。

接管兼容用例需要开发期 PyYAML，可显式设置 `CLASH_MANAGER_TEST_PYTHON` 为已验证的解释器路径；不设置时跳过该用例。此依赖仅用于调用仓库旧同步器，发行包不包含 Python。正式全量验收应同时设置该变量并执行隔离内核测试。

离屏界面检查仅使用独立演示数据，输出必须为尚不存在的绝对路径：

```powershell
npm start -- --demo --data-dir '独立演示目录' --render-preview '新预览图片绝对路径'
```

## 边界

- 写入兼容基线为 Clash Verge Rev 2.5.8。其他版本可以读取，应用前会拒绝未通过兼容校验的版本。
- 软件维护的新来源目前接受 Clash/Mihomo YAML 节点列表；不执行订阅中的 JavaScript，不自动转换全部私有订阅协议。
- 应用等待用户从托盘正常退出客户端。没有强杀、模拟点击或隐藏窗口代替退出的逻辑。
- 软件、格式、方案正式版本、来源私有快照、provider 数据及应用凭证分别记录。只有完成运行核验的事务才确认成功。
- 当前包为未签名的开发便携版。实际接管、登录计划任务和真实设备升级仍需用户环境验收；不得根据隔离测试宣称已部署到用户活动配置。

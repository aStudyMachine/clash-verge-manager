# Repository Guidelines

## 项目定位

Windows x64 独立配置工作台，集中维护来源订阅、固定节点、场景、策略组与分流规则，明确应用到 Clash Verge 的一个「订阅聚合」入口。代理内核、TUN 和系统代理仍由 Clash Verge 承担。

- 领域词汇见 `GLOSSARY.md`；产品选择见 `docs/design/`，行为契约见 `docs/specs/`，架构决策见 `docs/adr/`。
- 用户入口是 `docs/subscription-manager.md`；开发、构建与验证命令见 `README.md`。

## 目录

| 位置 | 内容 |
|---|---|
| `src/core/` | 无 Electron 依赖的领域实现 |
| `src/desktop/` | 受限 IPC 与进程生命周期 |
| `src/renderer/` | React 编辑器 |
| `native/` | Windows 进程、互斥与计划任务适配 |
| `resources/` | 随包数据与运行资源锁 |
| `scripts/` | 构建、资源准备与隔离内核测试 |
| `test/` | 经 `Manager.execute(Command)` 的行为测试 |
| `tmp/` | 本机临时目录，仅本地使用，不入库 |

## 开发与验证

Windows 命令统一使用 PowerShell 7，从仓库根目录运行。开发需要 Node.js 24 或更新版本和 npm。

```powershell
npm ci
npm run typecheck
npm test
node scripts/test-mihomo.mjs
git diff --check
```

- 修改 `src/core/` 后必须跑 `npm run typecheck` 与 `npm test`；语法通过不等于部署成功。
- 隔离内核测试用本机辅助程序只读发现已安装的 Mihomo，启动本轮专属子进程和回环控制器，结束时只停止自己创建的子进程。它不验证外部网站。
- 构建或打包前确认 `release/`、`dist/`、`resources/bin/` 未被提交。
- 需要操作电脑界面时，由 Agent 说明具体步骤并交给用户手动操作，等待用户反馈后继续核验；不得用界面自动化工具代替用户操作。

## 编码规范

- TypeScript 使用两个空格缩进、分号和 `camelCase`；注释与文档使用中文。
- 节点和代理组名称保留原字符、表情及标点；按组名幂等更新，缺少必要 provider、节点或选择组时明确报错。
- 领域规则模块保持不依赖 Electron 和 Windows；平台相关能力集中在对应模块或 `native/`。
- 用户可见错误不直接回显原始异常、凭据或本机路径。

## 敏感信息边界

本仓库公开可读，不得提交任何真实订阅、节点凭据或本机路径。

- 禁止入库：真实订阅 URL、节点连接信息与密码、控制器密钥、原始 provider 响应、部署备份、本机绝对路径、机场名称。
- 演示数据必须为合成内容，使用 `example.invalid` 等保留域名。
- 提交前运行 `node scripts/scan-secrets.mjs`；命中即停止提交并清理。

## 提交与发布

Git 操作按「开工 → 提交 → 合并 → 收尾」四阶段执行。

- 开工：从最新 `main` 建 `<type>/<YYMMDD>-<HHMM>-<描述>` 工作分支，type 取 `feature|fix|docs|chore|refactor|perf|test|merge`，描述不超过 12 个汉字；不在 `main` 直接提交。
- 提交：标题使用 `<type>(<scope>): <用户可感知的结果>`，type 仅限 `feat|fix|perf|refactor|test|docs|build|chore`；一个提交只服务一个可独立回滚的变更；标题建议不超过 40 字、硬上限 65 字，不加句号；未真机验收的检查点以 `[checkpoint，未验收]` 结尾且不带版本号。正文写「变更 / 验证 / 验收 / 文档」，有遗留时补「风险/遗留」，建议不超过 600 字、硬上限 900 字。提交前必须通过提交信息校验，不得用 `--no-verify` 绕过。
- 合并：使用 `git merge --no-ff`，并显式写明合并提交信息；收尾只列出可删分支，不自动删除；仅真机验收通过的发布提交打 annotated tag。
- 授权：用户说「提交代码」即授权本地 commit，说「提交代码并推送」即授权 commit 和 push；执行前说明拟用 message 与推送目标；未明确要求推送时不 push。
- 正式发行包不依赖 Python 与源码仓库；发行前核对 `resources/THIRD_PARTY_NOTICES.md` 的数据来源与许可范围。

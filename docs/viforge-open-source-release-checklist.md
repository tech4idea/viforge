# ViForge 开源交付检查清单

本文记录 ViForge 首个开源桌面版发布前需要完成的产品、工程和合规检查。它不是法律意见，只作为发布前的工程自查清单；涉及商标、license 解释和跨境合规时，仍应以专业法律意见为准。

## 目标

ViForge P0 的发布目标是：用户可以通过开源仓库理解产品定位，通过安装包启动本地优先的 AI 协作工作台，并在不接触命令行的情况下完成模型配置和一次完整协作创作。

因此 P0 不能只验证 Electron、API、PostgreSQL 和 Web 能跑通，还要确认以下内容清楚、可交付、可解释：

- 产品名称和定位。
- 开源协议和第三方依赖。
- 内置二进制和安装包分发。
- 用户数据、API Key、日志和浏览器授权边界。
- README、安装包文案和应用内用户提示。

## 1. 名称与定位

暂定产品名：**ViForge**。

定位：本地优先、可自定义、Agent 可迭代优化的 AI 协作工作台，面向创意生产和知识工作。

发布前需要检查：

- 是否存在明显同名软件、AI 产品、开发者工具或创意工作台。
- 是否存在高风险商标冲突。
- GitHub 仓库名、npm 包名、安装包应用名、窗口标题、桌面快捷方式名称是否一致。
- README 首屏是否能讲清楚 ViForge 不是单一小说/剧本工具，也不是通用 coding desktop 的复制品。
- 仓库内部是否继续允许 `viforge` 作为工程代号；若允许，需要明确用户可见命名逐步收敛到 ViForge。

P0 建议口径：

```text
ViForge is a local-first AI collaboration workbench for creative and knowledge work. It helps people turn ideas, judgment, and personal methodology into reusable agents, skills, knowledge bases, and evaluable workflows.
```

中文口径：

```text
ViForge 是一个本地优先的 AI 协作工作台，面向创意生产和知识工作。它帮助用户把创意、判断和个人方法论沉淀为可复用、可迭代、可评测的 Agent、技能、知识库和工作流。
```

## 2. 开源协议

仓库主 license 已定为 Apache-2.0，并在仓库根目录提供 `LICENSE`。根目录 `NOTICE` 记录 ViForge 项目 attribution，`THIRD_PARTY_NOTICES.md` 记录 P0 发布需要随安装包关注的第三方组件和二进制分发边界。

仍需在公开发布前人工确认：

- 是否需要保留商标权或品牌使用限制。
- 是否需要更完整的第三方 license 汇总文件随每个 release artifact 分发。
- 当前依赖 license 摘要里是否存在团队不可接受的条款。

依赖检查至少覆盖：

- npm workspace 所有生产依赖和构建依赖。
- Electron / electron-builder。
- Hono、React、Vite、LangChain、LangGraph 相关包。
- PostgreSQL、pgvector、Playwriter 相关组件。
- 打包进安装包的所有二进制、动态库、字体、图标和静态资源。

发布前脚本：

```bash
pnpm licenses:list
```

该命令用于生成当前 lockfile 对应的依赖 license 摘要。P0 发布前需要人工审阅输出，并把不可接受的 license 或缺失 license 标记为发布阻断项。

## 3. 第三方二进制

桌面安装包会内置 PostgreSQL binary 和 pgvector。发布前必须确认这些内容的来源、版本、构建方式和分发文本。

需要记录：

- PostgreSQL source version。
- pgvector source version。
- 构建平台和构建脚本。
- 是否包含动态库，以及这些动态库的 license。
- 安装包内是否包含对应 license 文本。
- 是否需要在应用内或安装目录放置 `THIRD_PARTY_NOTICES`。

最低要求：

- `docs/current/19-desktop-release-guide.md` 能说明二进制如何准备。
- release artifact 能追溯到具体源码版本或 CI 构建记录。
- 缺少 pgvector 时的退化行为写清楚，不误导用户以为一定启用了向量检索。

## 4. 数据与隐私

ViForge 的核心卖点之一是本地优先，因此必须把数据位置和边界写清楚。

README 和应用内设置页至少说明：

- 工作区文件保存位置。
- API Key 保存方式和返回展示策略。
- runtime config 保存位置。
- PostgreSQL 数据目录。
- Agent 记忆、聊天会话、日志和 run artifact 保存位置。
- 浏览器授权由 Playwriter/浏览器扩展控制，ViForge 不应声称拥有未授权页面访问能力。
- 卸载或迁移数据时用户应该删除或备份哪些目录。

P0 必须避免：

- 默认把用户文件、API Key 或日志上传到外部服务。
- 在没有说明的情况下记录完整敏感工具输出。
- 在 README 中暗示 ViForge 自带模型服务或托管云能力。

## 5. 安全边界

Agent 浏览器工具和文件工具需要明确用户确认边界。

高风险动作包括：

- 登录、授权、绑定账户。
- 发布、提交、发送、付款。
- 删除远端数据。
- 修改线上配置。
- 购买、下单或其他不可轻易撤销的操作。

P0 要求：

- 文档声明高风险浏览器动作前必须用户确认。
- Agent 工具说明中保留确认要求。
- Playwriter 未连接或未授权时，Agent 不能假装已经访问网页。
- 桌面模式的本地访问 token 和浏览器直连限制保持启用。

## 6. README 与首屏体验

README 首屏建议包含：

- 一句话定位。
- 适合的使用场景。
- 与通用 coding desktop / office assistant 的差异。
- 本地优先数据说明。
- 安装和启动方式。
- 模型配置说明。
- 当前限制。

应用首屏建议避免只呈现内部工程概念。P0 应让用户第一眼看到：

- ViForge 名称。
- 当前是本地工作台。
- 需要配置 OpenAI-compatible 模型服务。
- 数据目录在哪里。
- 如何开始第一个项目或临时协作会话。

## 7. 发布前工程检查

P0 发布前至少运行：

```bash
pnpm --filter @viforge/api typecheck
pnpm --filter @viforge/web typecheck
pnpm --filter @viforge/web build
pnpm --filter @viforge/api test
pnpm --filter @viforge/web test
pnpm desktop:pack
```

如果构建安装包，还需要：

```bash
pnpm desktop:dist
```

桌面手测至少覆盖：

- 首次启动选择数据目录。
- 配置 Base URL、API Key、文本模型、embedding 模型。
- 创建项目。
- 发起一次普通创作会话。
- 写入一个工作区文件。
- 完全退出后再次启动，确认工作区和配置仍在。
- Playwriter 未连接时提示清楚。
- Playwriter 已连接时能读取授权页面状态。

## 8. P0 发布阻断项

以下问题存在时不建议公开发布：

- 产品名称存在明确高风险冲突。
- 仓库缺少主 license。
- 内置二进制来源无法追溯。
- 安装包缺少第三方 license/notice。
- API Key 明文展示给前端或日志。
- 桌面模式可被普通浏览器绕过 token 访问。
- 无法稳定完全退出 API/PostgreSQL 子进程。
- README 未说明本地数据、模型服务和浏览器自动化边界。

## 9. 当前状态

截至当前 P0 分支，已经完成：

- 从最新 `origin/master` 创建 P0 feature 分支，并确认桌面端实现已经合入 master。
- 用户可见产品名、窗口标题、托盘、安装器文案、桌面包名、README 和 product profile 标题收敛到 ViForge。
- 仓库根目录新增 `LICENSE`、`NOTICE` 和 `THIRD_PARTY_NOTICES.md`。
- `package.json` 和 workspace package 增加 Apache-2.0 license metadata。
- README 已说明 ViForge 定位、本地优先数据策略、模型配置、API Key 不回显、浏览器自动化边界和第三方 notice。
- 运行设置页已补充本地优先、API Key、模型服务和 Playwriter 高风险动作确认说明。
- 桌面打包配置会把 `LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md` 放入 release resources。
- Windows `win32-x64` PostgreSQL bundle 检查通过，并确认包含 pgvector `vector.control` 与 `vector.dll`。
- Linux 桌面目录包可以构建，且 release resources 中包含 `LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md`。
- `pnpm --filter @viforge/api typecheck`、`pnpm --filter @viforge/web typecheck`、`pnpm --filter @viforge/desktop build`、`pnpm --filter @viforge/api test`、`pnpm --filter @viforge/web test` 和 `pnpm --filter @viforge/web build` 已在 P0 分支通过。
- `pnpm desktop:pack` 已在 Linux/WSL 环境通过，输出 `release/desktop/linux-unpacked`，并确认 release resources 中包含 `LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md`。
- `pnpm licenses:list` 可生成依赖 license 摘要；输出中包含 `AFL-2.1 OR BSD-3-Clause`、`MPL-2.0 OR Apache-2.0`、`Python-2.0`、`WTFPL`、`WTFPL OR ISC` 等需要发布前人工确认的条目。

仍然不能自动判定完成、需要发布前人工确认：

- ViForge 名称的商标和同名产品风险。
- Windows 真实安装包 `pnpm desktop:dist` 的构建和安装向导手测。
- Windows 首次启动、配置模型、创建项目、发起创作、完全退出并重启的数据保留手测。
- Windows 安装包内 Electron/Chromium/PostgreSQL/pgvector/Playwriter notice 文本是否满足最终分发要求。
- 依赖 license 摘要是否存在团队不可接受的条款。
- Linux 当前本地 PostgreSQL bundle 缺少 pgvector；如果发布 Linux AppImage 并要求向量检索，需补齐 pgvector 或明确退化为文本检索。

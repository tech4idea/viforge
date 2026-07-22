# ViForge

中文 | [English](./README.en.md)

ViForge 是一个本地优先的 AI 协作工作台，面向创意生产、知识工作和可持续迭代的 Agent 工作流。它把项目文件、创作助手、可复用技能、知识库、模型配置、运行日志和评测流程放在同一个可控工作区中，让用户把自己的判断、方法论和审美沉淀为可复用的 AI 协作能力。

当前实现重点服务小说改编、情景剧创作和学习研究等工作流，同时保留产品 profile 机制，便于后续扩展到更多垂直场景。

## 核心特性

- 本地优先工作区：项目文件、Agent 配置、记忆、日志和评测产物默认保存在用户本机。
- 三栏创作工作台：文件树、编辑/预览标签页和创作助手协同工作。
- 多产品 profile：内置小说改编、情景剧创作和学习研究模板，可按项目选择不同系统提示词、目录结构和专业技能。
- LangGraph Agent 运行时：支持流式会话、工具调用、长期记忆和 PostgreSQL/pgvector 持久化。
- 可复用 Agent Skills：通过工作区内的 `SKILL.md` 管理可迭代的专业能力。
- Agent Harness：支持对 Agent提示词、工具描述，行文规则等变更进行复现、比较、评审、发布和回滚。
- 桌面单机版：当前支持 Windows 安装包，下载安装后即可使用。
- 微信接入与浏览器协作：支持微信入口和经过用户授权的浏览器自动化操作。

## 产品架构

<p align="center">
  <img src="./docs/architecture/level_architecture.png" alt="ViForge 产品架构图" width="900">
</p>

## 产品截图

<p align="center">
  <img src="./docs/screenshots/main_page.png" alt="工作台主页" width="900">
  <br>
  <strong>工作台主页</strong>
</p>

<p align="center">
  <img src="./docs/screenshots/harness_main_page.png" alt="Harness 主页" width="900">
  <br>
  <strong>Harness 主页</strong>
</p>

<p align="center">
  <img src="./docs/screenshots/connectors.png" alt="连接器" width="900">
  <br>
  <strong>连接器</strong>
</p>

## 安装与使用

### 桌面版

桌面版面向普通用户，当前支持 Windows 安装。下载安装包并完成安装后，打开 ViForge 即可进入工作台使用。

### Docker Compose 部署

仓库提供 Docker Compose 部署方式，适合需要服务化运行的场景。

```bash
docker compose up -d --build
```

更完整的部署说明见 [当前实现总览](./docs/current/README.md)。

### 本地开发运行

安装依赖：

```bash
pnpm install
```

启动本地开发服务：

```bash
pnpm dev
```

更多开发、测试和构建命令见 [测试与开发命令](./docs/current/09-tests-and-dev-commands.md)。

## 模型配置

ViForge 不内置托管模型服务。请在应用内的系统配置入口中设置兼容 OpenAI 协议的模型服务，包括 Base URL、API Key、文本模型、图片模型和 embedding 模型等。

系统配置会把 API Key 存在本地。API 只返回密钥是否已配置，不会把明文密钥回传给前端。

## 文档入口

- [当前实现总览](./docs/current/README.md)
- [测试与开发命令](./docs/current/09-tests-and-dev-commands.md)

## 许可与声明

本仓库采用 MIT License，见 [LICENSE](./LICENSE)。


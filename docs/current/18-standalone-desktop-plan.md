# 单机桌面版落地方案

单机版目标是让用户通过安装包一键启动 viwork，不再手动安装 Node、启动 Web/API、部署 PostgreSQL 或 Qdrant。高级用户仍可在运行设置里切换到自己的 PostgreSQL 或后续 LangGraph 官方支持的其他存储适配器。

## 产品形态

- 桌面端使用 Electron，安装包内置 Chromium 与 Node runtime，用户不需要预装 Node。
- Electron 主进程启动本地 API 服务，再用内置 WebView 窗口加载 `http://127.0.0.1:<local-port>`。默认优先使用 `3001`，如端口被占用会在后续端口中寻找可用端口。
- 桌面模式下 API 同时托管 `apps/web/dist` 静态资源，所以不需要单独 Vite dev server 或浏览器入口。
- 桌面模式会生成一次性访问 token，Electron 首屏用 `desktopToken` 建立 HttpOnly cookie；未带 token 的本机浏览器请求会被 API 拒绝，避免“做了 WebView 但仍可当浏览器版访问”的产品形态混淆。
- 本地数据放在 Electron `userData/data` 下，包括工作区、日志、运行配置和内置 PostgreSQL 数据目录。

## 数据库策略

当前 LangGraph JS runtime 在本仓库使用两类存储：

- checkpointer：`PostgresSaver`
- 长期记忆 Store：`PostgresStore`

这两者来自 `@langchain/langgraph-checkpoint-postgres`，稳定路径是 PostgreSQL/pgvector。为了按 LangGraph 适配宽度做最小自研，单机版默认走内置 PostgreSQL binary，而不是自己实现 SQLite Store。这样本地默认和高级部署使用同一套 LangGraph 存储语义。

运行设置支持三种模式：

- `embedded-postgres`：桌面版默认，启动安装包内 bundled PostgreSQL binary。
- `external-postgres`：用户填写自己的 PostgreSQL connection string。
- `custom`：为后续 LangGraph 官方更多 adapter 预留配置入口。

向量检索默认使用 `pgvector`。因为桌面默认已经提供内置 PostgreSQL，产品运行态不再提供内存临时存储模式；自动化测试可显式设置 `VIWORK_LANGGRAPH_ALLOW_IN_MEMORY=1` 使用 LangGraph `MemorySaver` / `InMemoryStore` 后备。未配置 embedding key 或 embedded PostgreSQL bundle 未包含 pgvector 扩展时，`PostgresStore` 仍持久化长期记忆，`search()` 退化为 PostgreSQL 文本搜索。

## 打包工具

桌面壳位于 `apps/desktop`：

- `electron` 提供内置 Chromium、Node runtime 和应用主进程。
- `electron-builder` 生成 Windows NSIS 一键安装包、macOS DMG 和 Linux AppImage。
- Windows 目标配置为 NSIS `oneClick: true`，符合 exe 一键部署形态。
- `apps/desktop/scripts/build-api-bundle.mjs` 会把 API 打成桌面专用 Node bundle，并复制产品 prompt 资源，安装包运行时不依赖用户机器上的 Node 或源码目录。

PostgreSQL binary 不提交到仓库。打包前应把对应平台文件放到：

```text
apps/desktop/resources/postgres/<platform>-<arch>/bin
```

例如 Windows x64：

```text
apps/desktop/resources/postgres/win32-x64/bin/initdb.exe
apps/desktop/resources/postgres/win32-x64/bin/pg_ctl.exe
apps/desktop/resources/postgres/win32-x64/bin/postgres.exe
```

也可以用 `VIWORK_POSTGRES_BIN_DIR` 指向外部 PostgreSQL bin 目录做开发调试。

推荐 release 流程是从 PostgreSQL 官方稳定版源码构建可重定位 bundle，而不是依赖第三方二进制项目。脚本入口：

```bash
# 先从 https://www.postgresql.org/ftp/source/ 下载并解压官方稳定版源码
VIWORK_POSTGRES_SOURCE_DIR=/path/to/postgresql-16.10 pnpm --filter @viwork/desktop build:postgres
```

该脚本默认 `VIWORK_POSTGRES_SOURCE_VERSION=16.10`，在 Linux/macOS 上执行官方源码的 `./configure && make && make install`，并使用 `--without-readline --without-zlib --without-icu --without-ldap --without-pam --without-openssl` 降低运行时动态库依赖；输出会复制到 `apps/desktop/resources/postgres/<platform>-<arch>`。Windows 建议在 CI 或专用构建机中用官方源码构建后，再通过 `VIWORK_POSTGRES_BUNDLE_SOURCE` 注入打包。

pgvector 也需要从源码构建进 PostgreSQL bundle，脚本入口：

```bash
# 先从 https://github.com/pgvector/pgvector/releases 下载并解压 release 源码
VIWORK_PGVECTOR_SOURCE_DIR=/path/to/pgvector-0.8.0 pnpm --filter @viwork/desktop build:pgvector
```

`build:pgvector` 会使用 bundled PostgreSQL 的 `bin/pg_config` 编译并安装 `vector.so` / `vector.control` 到同一个资源目录。打包前 `prepare:postgres` 会检查 pgvector 是否存在；默认缺失时只告警并退化为 PostgreSQL 文本检索，发布正式安装包时建议设置 `VIWORK_REQUIRE_PGVECTOR=1` 让缺失 pgvector 直接失败。

内置 PostgreSQL 启动时会优先使用 `VIWORK_EMBEDDED_POSTGRES_PORT`，默认 `15432`。如果端口被占用但不是当前数据目录对应的 PostgreSQL 实例，API 会在后续端口中寻找可用端口并写入实际 `DATABASE_URL`，避免和用户机器已有 PostgreSQL 冲突。Electron 退出时会停止由本次 API 进程启动的内置 PostgreSQL；如果检测到同一数据目录已有服务运行，则复用该服务。

打包命令会先执行 `pnpm --filter @viwork/desktop prepare:postgres` 检查这些文件。若希望从外部目录复制，可设置：

```bash
VIWORK_POSTGRES_BUNDLE_SOURCE=/path/to/postgresql-root pnpm desktop:dist
```

交叉打包时可用 `VIWORK_POSTGRES_PLATFORM_ARCH=win32-x64` 指定要检查或复制的目标平台目录。

Linux 本机打包时，`prepare:postgres` 还会用 `ldd` 检查 bundled PostgreSQL binary 是否缺少动态库，避免安装包生成后才在用户机器上启动失败。资源包必须自带 PostgreSQL 运行所需的 `libpq`、ICU 等依赖库，或来自一个已经整理好的可重定位 PostgreSQL distribution。若 source 目录只有 PostgreSQL 自身的 `bin/lib/share`，可额外设置 `VIWORK_POSTGRES_BUNDLE_LIB_SOURCE=/path/to/runtime-libs`，脚本会从该目录补齐缺失的 Linux 动态库。

## 运行设置

前端侧新增“运行设置”入口，可配置：

- OpenAI-compatible Base URL、API Key、文本模型、图片模型、embedding 模型与维度。
- LangGraph 数据库模式、连接字符串、自定义 adapter 名称和向量存储策略。

后端配置持久化到 `<dataRoot>/runtime-config.json`。API 启动时会读取该配置并写入当前进程环境变量，供现有模型调用和 LangGraph memory 初始化复用。

连接字符串和 API Key 属于敏感配置：后端只返回 `apiKeyConfigured` / `connectionStringConfigured` 和脱敏展示值；前端表单不会把脱敏值回写为真实连接字符串。用户留空保存时表示保持既有密钥或连接字符串不变。

## 命令

开发：

```bash
pnpm --filter @viwork/desktop dev
```

目录打包：

```bash
pnpm desktop:pack
```

安装包：

```bash
pnpm desktop:dist
```

## 当前边界

- 已保留 Docker Compose 和普通 Web/API 开发模式；桌面模式通过 `VIWORK_DESKTOP=1` 和 `VIWORK_STATIC_WEB_ROOT` 启用。
- 内置 PostgreSQL binary 的下载、校验和多平台资源准备还需要单独做 release 脚本。
- 数据迁移工具暂不纳入本阶段；后续可围绕 `runtime-config.json` 和 PostgreSQL dump/restore 做专门工具。

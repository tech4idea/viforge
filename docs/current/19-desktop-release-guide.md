# 单机桌面版构建与发布教程

本文面向把 viwork 单机版打成可安装程序的流程。核心原则：先准备好对应平台的 PostgreSQL + pgvector 资源包，再运行 Electron Builder 生成安装包。

## 1. 是否必须在对应平台构建

建议按平台构建：

- Windows 安装包：在 Windows 机器或 GitHub Actions `windows-latest` 构建。
- macOS 安装包：在 macOS 机器或 GitHub Actions `macos-latest` 构建。
- Linux AppImage：在 Linux 机器或 GitHub Actions `ubuntu-latest` 构建。

Electron Builder 有一定交叉打包能力，但 PostgreSQL binary、动态库、pgvector 扩展和安装包签名都强依赖平台。正式 release 不建议在一个平台上交叉打所有平台包。

## 2. Windows 本地验证建议

在提交和推送前，最好至少在 Windows 本机做一次验证，确认 exe 可以打开、内置 PostgreSQL 可以启动、运行设置页面能保存模型配置。

如果当前手头没有 Windows 环境，也可以先提交到 GitHub，用 GitHub Actions 在 Windows runner 上构建。CI 只能证明“能构建”，不能完全替代人工打开应用验证。

## 3. 准备基础环境

Windows 本地需要：

1. Node.js 22。
2. pnpm。
3. Git。
4. Visual Studio Build Tools，用于编译 PostgreSQL/pgvector 时使用 MSVC 工具链。

安装依赖：

```powershell
pnpm install
```

## 4. 准备 PostgreSQL binary

桌面版不会要求用户安装 PostgreSQL，但安装包里必须内置一份 PostgreSQL binary。资源目录约定为：

```text
apps/desktop/resources/postgres/<platform>-<arch>/
```

Windows x64 对应：

```text
apps/desktop/resources/postgres/win32-x64/
```

目录里至少需要：

```text
bin/initdb.exe
bin/pg_ctl.exe
bin/postgres.exe
bin/createdb.exe
bin/psql.exe
lib/
share/
```

推荐来源是 PostgreSQL 官方稳定版本源码，或官方安装包提取出的可重定位目录。不要依赖来路不明的第三方 binary。当前项目提供源码构建脚本：

```powershell
$env:VIWORK_POSTGRES_SOURCE_DIR="C:\path\to\postgresql-16.10"
pnpm --filter @viwork/desktop build:postgres
```

当前 `build:postgres` 脚本主要覆盖 Linux/macOS 的 `configure && make install` 流程。Windows 更稳妥的做法是：

1. 在 Windows 构建机上按 PostgreSQL 官方 Windows 编译文档构建。
2. 或从官方 Windows 安装包安装到临时目录。
3. 将安装后的 PostgreSQL 根目录复制到 `apps/desktop/resources/postgres/win32-x64/`。

复制后运行检查：

```powershell
$env:VIWORK_POSTGRES_PLATFORM_ARCH="win32-x64"
pnpm --filter @viwork/desktop prepare:postgres
```

## 5. 准备 pgvector

LangGraph Store 的语义检索需要 pgvector。正式安装包建议包含 pgvector，否则应用会退化为 PostgreSQL 文本检索。

下载 pgvector release 源码，例如 `v0.8.0`：

```powershell
$env:VIWORK_PGVECTOR_SOURCE_DIR="C:\path\to\pgvector-0.8.0"
pnpm --filter @viwork/desktop build:pgvector
```

脚本会使用 `apps/desktop/resources/postgres/<platform>-<arch>/bin/pg_config` 编译并安装 pgvector。完成后应能看到：

```text
apps/desktop/resources/postgres/win32-x64/share/extension/vector.control
apps/desktop/resources/postgres/win32-x64/lib/vector.dll
```

发布前建议强制检查 pgvector：

```powershell
$env:VIWORK_REQUIRE_PGVECTOR="1"
$env:VIWORK_POSTGRES_PLATFORM_ARCH="win32-x64"
pnpm --filter @viwork/desktop prepare:postgres
```

## 6. 构建目录版

目录版适合本地快速验证，不生成安装器：

```powershell
pnpm desktop:pack
```

Windows 输出目录通常在：

```text
release/desktop/win-unpacked/
```

打开 `viwork.exe` 验证：

1. 应用窗口能启动。
2. 不需要用户安装 Node。
3. 不需要用户手动启动浏览器。
4. 运行设置页面能打开。
5. 默认数据库模式是内置 PostgreSQL。
6. 填写 OpenAI 协议 Base URL、API Key、模型后能保存。

## 7. 构建 exe 安装包

Windows 一键安装包：

```powershell
pnpm desktop:dist
```

输出目录：

```text
release/desktop/
```

Electron Builder 当前配置使用 NSIS `oneClick: true`，也就是用户双击 exe 后一键安装。

## 8. GitHub Actions 构建建议

可以把代码推到 GitHub 后用 Actions 构建。推荐每个平台单独 job：

- `windows-latest` 构建 Windows exe。
- `macos-latest` 构建 DMG。
- `ubuntu-latest` 构建 AppImage。

关键问题是 PostgreSQL/pgvector bundle 的准备。不要在每次 CI 都从零手动处理一遍，建议二选一：

1. 在 CI 中从官方源码编译 PostgreSQL 和 pgvector，然后打包。
2. 预先把可信的 PostgreSQL/pgvector bundle 放到内部 release artifact，再由 CI 下载到 `apps/desktop/resources/postgres/<platform>-<arch>/`。

CI 中至少运行：

```bash
pnpm install
pnpm --filter @viwork/api typecheck
pnpm --filter @viwork/web typecheck
pnpm --filter @viwork/desktop build
VIWORK_REQUIRE_PGVECTOR=1 pnpm --filter @viwork/desktop prepare:postgres
pnpm desktop:dist
```

## 9. 推送前检查清单

提交前建议确认：

```bash
git status --short
pnpm --filter @viwork/api typecheck
pnpm --filter @viwork/web typecheck
pnpm --filter @viwork/desktop build
pnpm --filter @viwork/api test -- runtimeConfig.test.ts desktopAccess.test.ts
pnpm desktop:pack
```

不要提交以下产物：

- `release/`
- `apps/web/dist/`
- `apps/desktop/dist/`
- PostgreSQL 运行数据目录
- `.env` 或 API Key

PostgreSQL binary bundle 目前被 `.gitignore` 排除，发布流程应通过 CI 下载/构建，或在本地构建安装包前临时放入资源目录。

## 10. 当前已知注意点

- 没有 pgvector 时应用仍能启动，但 LangGraph 长期记忆会退化为文本检索。正式包建议强制 `VIWORK_REQUIRE_PGVECTOR=1`。
- Linux/WSL 下运行图形应用可能受沙箱或显示环境限制，目录包能构建不代表 GUI 可在 WSL 中正常打开。
- GitHub Actions 生成 macOS 包若要分发给普通用户，还需要 Apple Developer 签名和 notarization；内部测试可先跳过。

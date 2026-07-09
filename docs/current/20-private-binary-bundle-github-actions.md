# 私有 GitHub 仓库存放桌面二进制资源的打包方案

当前 PostgreSQL + pgvector bundle 存放在独立 GitHub 仓库，再由主仓库的 GitHub Actions 在构建时下载。这个方案适合早期内部发布，配置少，权限清晰。

## 1. 当前二进制仓库

当前使用的 public 仓库：

```text
YukeonWayne/pg_pgvector_binary
```

当前 Windows x64 bundle 通过 GitHub Release 发布：

```text
release tag: v18.4-pgvector0.8.3-win32-x64
asset: postgres-18.4-pgvector-0.8.3-win32-x64.zip
```

zip 解压后应能找到 PostgreSQL 根目录，目录里至少包含：

```text
bin/
  initdb.exe
  pg_ctl.exe
  postgres.exe
  createdb.exe
  psql.exe
  pg_config.exe
lib/
  vector.dll
  ...
share/
  extension/
    vector.control
    vector--0.8.0.sql
    ...
```

pgvector 不需要单独目录，只要已经安装进对应平台的 PostgreSQL bundle 即可。

## 2. 为什么不放主仓库

PostgreSQL bundle 会很大，而且是平台相关二进制。放主仓库会让代码 clone 变慢，也容易把构建产物和源码混在一起。单独仓库更适合：

- 单独控制访问权限。
- 单独更新二进制版本。
- GitHub Actions 构建时按需下载。
- 主仓库保持干净。

## 3. GitHub Actions 权限

当前 `YukeonWayne/pg_pgvector_binary` 是 public 仓库，GitHub Actions 不需要额外 token。

如果后续把二进制仓库改回 private，再创建一个 Fine-grained Personal Access Token：

1. 进入 GitHub `Settings -> Developer settings -> Personal access tokens -> Fine-grained tokens`。
2. 选择只允许访问 `YukeonWayne/pg_pgvector_binary`。
3. 权限只给 `Contents: Read-only`。
4. 在当前主仓库 `tech4idea/viforge` 的 `Settings -> Secrets and variables -> Actions` 新增 secret：

```text
DESKTOP_BINARIES_TOKEN=<你的 token>
```

private 仓库场景还需要在 workflow 的下载逻辑里把 token 传给 `VIFORGE_POSTGRES_BUNDLE_GITHUB_TOKEN`。public 仓库场景不需要配置这个 secret，也不要把 token 写入仓库。

## 4. 已配置的 Windows Actions

主仓库已提供 Windows 桌面打包 workflow：

```text
.github/workflows/desktop-windows.yml
```

workflow 支持两种触发方式：`pull_request` 用于在不改默认分支的情况下验证配置；`workflow_dispatch` 用于合入默认分支后手动打包。手动触发时可以提供 `bundle_release_tag` 输入，默认下载 `YukeonWayne/pg_pgvector_binary` 的 `v18.4-pgvector0.8.3-win32-x64` release。

核心流程：

1. PR 改动相关路径时自动验证，或合入默认分支后手动触发打包。
2. checkout 主仓库代码。
3. 安装 pnpm 11.3.0 和 Node.js 22。
4. 运行 `pnpm install --frozen-lockfile`。
5. 设置 `VIFORGE_POSTGRES_BUNDLE_RELEASE_REPO`、`VIFORGE_POSTGRES_BUNDLE_RELEASE_TAG` 和 `VIFORGE_POSTGRES_BUNDLE_ASSET_NAME`，运行 `prepare:postgres` 自动下载并校验 PostgreSQL + pgvector bundle。
6. 运行 API 和 Web typecheck。
7. 运行 `pnpm desktop:dist` 生成 Windows NSIS 安装包。
8. 上传 `release/desktop/*.exe`、`*.blockmap` 和 `latest*.yml` 为 Actions artifact。

workflow 使用 `actions/checkout@v7`、`actions/setup-node@v6`、`pnpm/action-setup@v6` 和 `actions/upload-artifact@v7`，避免 GitHub Actions 对 Node 20 action runtime 的 deprecation warning。

## 5. Windows job 配置

当前 workflow 内容等价于：

```yaml
name: Desktop Windows

on:
  pull_request:
    paths:
      - .github/workflows/desktop-windows.yml
      - apps/api/**
      - apps/desktop/**
      - apps/web/**
      - packages/shared/**
      - package.json
      - pnpm-lock.yaml
      - pnpm-workspace.yaml
  workflow_dispatch:
    inputs:
      bundle_release_tag:
        description: GitHub Release tag from YukeonWayne/pg_pgvector_binary
        required: false
        default: v18.4-pgvector0.8.3-win32-x64

permissions:
  contents: read

jobs:
  build-windows:
    name: Build Windows desktop installer
    runs-on: windows-latest
    timeout-minutes: 60

    env:
      VIFORGE_POSTGRES_PLATFORM_ARCH: win32-x64
      VIFORGE_REQUIRE_PGVECTOR: '1'
      VIFORGE_POSTGRES_BUNDLE_RELEASE_REPO: YukeonWayne/pg_pgvector_binary
      VIFORGE_POSTGRES_BUNDLE_RELEASE_TAG: ${{ inputs.bundle_release_tag || 'v18.4-pgvector0.8.3-win32-x64' }}
      VIFORGE_POSTGRES_BUNDLE_ASSET_NAME: postgres-18.4-pgvector-0.8.3-win32-x64.zip

    steps:
      - name: Checkout source
        uses: actions/checkout@v7

      - name: Setup pnpm
        uses: pnpm/action-setup@v6
        with:
          version: 11.3.0

      - name: Setup Node.js
        uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Verify or download PostgreSQL bundle
        run: pnpm --filter @viforge/desktop prepare:postgres

      - name: Typecheck API
        run: pnpm --filter @viforge/api typecheck

      - name: Typecheck web
        run: pnpm --filter @viforge/web typecheck

      - name: Build Windows installer
        run: pnpm desktop:dist

      - name: Upload Windows artifacts
        uses: actions/upload-artifact@v7
        with:
          name: viforge-windows-desktop
          path: |
            release/desktop/*.exe
            release/desktop/*.blockmap
            release/desktop/latest*.yml
          if-no-files-found: error
```

## 6. 本地使用同一个二进制仓库

本地 Windows 验证时也可以让 `prepare:postgres` 从 release 自动下载：

```powershell
$env:VIFORGE_POSTGRES_PLATFORM_ARCH="win32-x64"
$env:VIFORGE_REQUIRE_PGVECTOR="1"
$env:VIFORGE_POSTGRES_BUNDLE_RELEASE_REPO="YukeonWayne/pg_pgvector_binary"
$env:VIFORGE_POSTGRES_BUNDLE_RELEASE_TAG="v18.4-pgvector0.8.3-win32-x64"
$env:VIFORGE_POSTGRES_BUNDLE_ASSET_NAME="postgres-18.4-pgvector-0.8.3-win32-x64.zip"
pnpm --filter @viforge/desktop prepare:postgres
pnpm desktop:pack
```

## 7. 注意事项

- 二进制仓库不要放数据库运行数据，只放 PostgreSQL 程序文件和 pgvector 扩展文件。
- public 仓库不需要 GitHub token；private 仓库才需要 token，并且只能放到 GitHub Actions secrets。
- 二进制仓库建议用 GitHub Release tag 标记版本，例如 `v18.4-pgvector0.8.3-win32-x64`。
- 主仓库 workflow 触发时可以把 `bundle_release_tag` 固定为某个 release tag，避免二进制资源变化导致同一份代码构建结果不一致。

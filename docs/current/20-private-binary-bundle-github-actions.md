# 私有 GitHub 仓库存放桌面二进制资源的打包方案

如果不想先搭 OSS，可以用一个私有 GitHub 仓库存放 PostgreSQL + pgvector bundle，再让主仓库的 GitHub Actions 在构建时拉取。这个方案适合早期内部发布，配置少，权限清晰。

## 1. 当前二进制仓库

当前使用的私有仓库：

```text
YukeonWayne/pg_pgvector_binary
```

目录结构约定：

```text
postgres/
  win32-x64/
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
  linux-x64/
    bin/
    lib/
    share/
  darwin-arm64/
    bin/
    lib/
    share/
```

把每个平台的 PostgreSQL 根目录完整放进去。pgvector 不需要单独目录，只要已经安装进对应平台的 PostgreSQL bundle 即可。

## 2. 为什么不放主仓库

PostgreSQL bundle 会很大，而且是平台相关二进制。放主仓库会让代码 clone 变慢，也容易把构建产物和源码混在一起。单独私有仓库更适合：

- 单独控制访问权限。
- 单独更新二进制版本。
- GitHub Actions 构建时按需 checkout。
- 主仓库保持干净。

## 3. GitHub Actions 权限

如果主仓库和二进制仓库都在同一个 GitHub 账号或组织下，推荐创建一个 Fine-grained Personal Access Token：

1. 进入 GitHub `Settings -> Developer settings -> Personal access tokens -> Fine-grained tokens`。
2. 选择只允许访问 `YukeonWayne/pg_pgvector_binary`。
3. 权限只给 `Contents: Read-only`。
4. 在当前主仓库 `tech4idea/viforge` 的 `Settings -> Secrets and variables -> Actions` 新增 secret：

```text
DESKTOP_BINARIES_TOKEN=<你的 token>
```

不要把 token 写入仓库。workflow 只通过 `${{ secrets.DESKTOP_BINARIES_TOKEN }}` 读取。

## 4. 已配置的 Windows Actions

主仓库已提供 Windows 桌面打包 workflow：

```text
.github/workflows/desktop-windows.yml
```

workflow 支持两种触发方式：`pull_request` 用于在不改 `main` 的情况下验证配置；`workflow_dispatch` 用于合入默认分支后手动打包。手动触发时可以提供 `binaries_ref` 输入，默认从 `YukeonWayne/pg_pgvector_binary` 的 `main` 分支拉取二进制资源。如果二进制仓库用 tag 固定版本，可以在触发时把 `binaries_ref` 填成对应 tag。

核心流程：

1. PR 改动相关路径时自动验证，或合入默认分支后手动触发打包。
2. checkout 主仓库代码。
3. 安装 pnpm 11.3.0 和 Node.js 22。
4. 检查当前仓库是否配置了 `DESKTOP_BINARIES_TOKEN`。
5. 使用 `DESKTOP_BINARIES_TOKEN` checkout `YukeonWayne/pg_pgvector_binary` 到 `desktop-binaries/`。
6. 复制 `desktop-binaries/postgres/win32-x64` 到 `apps/desktop/resources/postgres/win32-x64`。
7. 设置 `VIFORGE_POSTGRES_PLATFORM_ARCH=win32-x64` 和 `VIFORGE_REQUIRE_PGVECTOR=1`，运行 `prepare:postgres` 强制校验 PostgreSQL 与 pgvector。
8. 运行 API 和 Web typecheck。
9. 运行 `pnpm desktop:dist` 生成 Windows NSIS 安装包。
10. 上传 `release/desktop/*.exe`、`*.blockmap` 和 `latest*.yml` 为 Actions artifact。

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
      binaries_ref:
        description: Git ref to checkout from YukeonWayne/pg_pgvector_binary
        required: false
        default: main

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

    steps:
      - name: Checkout source
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 11.3.0

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Verify desktop binaries token
        shell: pwsh
        env:
          DESKTOP_BINARIES_TOKEN: ${{ secrets.DESKTOP_BINARIES_TOKEN }}
        run: |
          if ([string]::IsNullOrWhiteSpace($env:DESKTOP_BINARIES_TOKEN)) {
            throw "Missing repository secret DESKTOP_BINARIES_TOKEN. Create a fine-grained GitHub token with read-only Contents access to YukeonWayne/pg_pgvector_binary, then add it to this repository's Actions secrets."
          }


      - name: Checkout PostgreSQL bundle
        uses: actions/checkout@v4
        with:
          repository: YukeonWayne/pg_pgvector_binary
          ref: ${{ inputs.binaries_ref || 'main' }}
          token: ${{ secrets.DESKTOP_BINARIES_TOKEN }}
          path: desktop-binaries

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Install PostgreSQL bundle
        shell: pwsh
        run: |
          $ErrorActionPreference = 'Stop'
          $platform = $env:VIFORGE_POSTGRES_PLATFORM_ARCH
          $source = "desktop-binaries/postgres/$platform"
          $target = "apps/desktop/resources/postgres/$platform"

          if (-not (Test-Path -LiteralPath $source)) {
            throw "PostgreSQL bundle not found at $source"
          }

          Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
          New-Item -ItemType Directory -Force -Path "apps/desktop/resources/postgres" | Out-Null
          Copy-Item -LiteralPath $source -Destination $target -Recurse

      - name: Verify PostgreSQL bundle
        run: pnpm --filter @viforge/desktop prepare:postgres

      - name: Typecheck API
        run: pnpm --filter @viforge/api typecheck

      - name: Typecheck web
        run: pnpm --filter @viforge/web typecheck

      - name: Build Windows installer
        run: pnpm desktop:dist

      - name: Upload Windows artifacts
        uses: actions/upload-artifact@v4
        with:
          name: viforge-windows-desktop
          path: |
            release/desktop/*.exe
            release/desktop/*.blockmap
            release/desktop/latest*.yml
          if-no-files-found: error
```

## 6. 本地使用同一个二进制仓库

本地 Windows 验证时也可以 clone 这个二进制仓库：

```powershell
git clone git@github.com:YukeonWayne/pg_pgvector_binary.git D:\deps\pg_pgvector_binary
Remove-Item -Recurse -Force apps\desktop\resources\postgres\win32-x64 -ErrorAction SilentlyContinue
Copy-Item -Recurse D:\deps\pg_pgvector_binary\postgres\win32-x64 apps\desktop\resources\postgres\win32-x64
$env:VIFORGE_POSTGRES_PLATFORM_ARCH="win32-x64"
$env:VIFORGE_REQUIRE_PGVECTOR="1"
pnpm --filter @viforge/desktop prepare:postgres
pnpm desktop:pack
```

## 7. 注意事项

- 私有二进制仓库不要放数据库运行数据，只放 PostgreSQL 程序文件和 pgvector 扩展文件。
- 不要把 GitHub token 写进仓库，只放到 GitHub Actions secrets。
- 二进制仓库建议用 git tag 标记版本，例如 `postgres-16.10-pgvector-0.8.0-win32-x64`。
- 主仓库 workflow 触发时可以把 `binaries_ref` 固定为某个 tag，避免二进制资源变化导致同一份代码构建结果不一致。

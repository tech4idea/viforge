# 私有 GitHub 仓库存放桌面二进制资源的打包方案

如果不想先搭 OSS，可以用一个私有 GitHub 仓库存放 PostgreSQL + pgvector bundle，再让主仓库的 GitHub Actions 在构建时拉取。这个方案适合早期内部发布，配置少，权限清晰。

## 1. 推荐仓库结构

新建一个私有仓库，例如：

```text
YukeonWayne/viforge-desktop-binaries
```

目录结构建议：

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
2. 选择只允许访问 `YukeonWayne/viforge-desktop-binaries`。
3. 权限只给 `Contents: Read-only`。
4. 在主仓库 `YukeonWayne/viforge` 的 `Settings -> Secrets and variables -> Actions` 新增 secret：

```text
DESKTOP_BINARIES_TOKEN=<你的 token>
```

## 4. Actions 拉取二进制资源

主仓库 workflow 中增加一个 checkout step，把私有二进制仓库拉到临时目录，再复制对应平台资源：

```yaml
- name: Checkout desktop binaries
  uses: actions/checkout@v4
  with:
    repository: YukeonWayne/viforge-desktop-binaries
    token: ${{ secrets.DESKTOP_BINARIES_TOKEN }}
    path: desktop-binaries

- name: Install PostgreSQL bundle
  shell: bash
  run: |
    PLATFORM_ARCH="${{ matrix.platform_arch }}"
    rm -rf "apps/desktop/resources/postgres/${PLATFORM_ARCH}"
    mkdir -p apps/desktop/resources/postgres
    cp -R "desktop-binaries/postgres/${PLATFORM_ARCH}" "apps/desktop/resources/postgres/${PLATFORM_ARCH}"
```

然后执行：

```yaml
- name: Verify PostgreSQL bundle
  run: pnpm --filter @viforge/desktop prepare:postgres
  env:
    VIFORGE_POSTGRES_PLATFORM_ARCH: ${{ matrix.platform_arch }}
    VIFORGE_REQUIRE_PGVECTOR: '1'

- name: Build desktop installer
  run: pnpm desktop:dist
  env:
    VIFORGE_POSTGRES_PLATFORM_ARCH: ${{ matrix.platform_arch }}
```

## 5. Windows job 示例

```yaml
name: Desktop Release

on:
  workflow_dispatch:

jobs:
  windows:
    runs-on: windows-latest
    strategy:
      matrix:
        include:
          - platform_arch: win32-x64
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 11.3.0

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Checkout desktop binaries
        uses: actions/checkout@v4
        with:
          repository: YukeonWayne/viforge-desktop-binaries
          token: ${{ secrets.DESKTOP_BINARIES_TOKEN }}
          path: desktop-binaries

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Install PostgreSQL bundle
        shell: pwsh
        run: |
          $platform = "${{ matrix.platform_arch }}"
          Remove-Item -Recurse -Force "apps/desktop/resources/postgres/$platform" -ErrorAction SilentlyContinue
          New-Item -ItemType Directory -Force "apps/desktop/resources/postgres" | Out-Null
          Copy-Item -Recurse "desktop-binaries/postgres/$platform" "apps/desktop/resources/postgres/$platform"

      - name: Verify PostgreSQL bundle
        run: pnpm --filter @viforge/desktop prepare:postgres
        env:
          VIFORGE_POSTGRES_PLATFORM_ARCH: ${{ matrix.platform_arch }}
          VIFORGE_REQUIRE_PGVECTOR: '1'

      - name: Build installer
        run: pnpm desktop:dist
        env:
          VIFORGE_POSTGRES_PLATFORM_ARCH: ${{ matrix.platform_arch }}

      - uses: actions/upload-artifact@v4
        with:
          name: viforge-windows
          path: release/desktop/*
```

## 6. 本地使用同一个二进制仓库

本地 Windows 验证时也可以 clone 这个二进制仓库：

```powershell
git clone https://github.com/YukeonWayne/viforge-desktop-binaries.git D:\deps\viforge-desktop-binaries
Remove-Item -Recurse -Force apps\desktop\resources\postgres\win32-x64 -ErrorAction SilentlyContinue
Copy-Item -Recurse D:\deps\viforge-desktop-binaries\postgres\win32-x64 apps\desktop\resources\postgres\win32-x64
$env:VIFORGE_POSTGRES_PLATFORM_ARCH="win32-x64"
$env:VIFORGE_REQUIRE_PGVECTOR="1"
pnpm --filter @viforge/desktop prepare:postgres
pnpm desktop:pack
```

## 7. 注意事项

- 私有二进制仓库不要放数据库运行数据，只放 PostgreSQL 程序文件和 pgvector 扩展文件。
- 不要把 GitHub token 写进仓库，只放到 GitHub Actions secrets。
- 二进制仓库建议用 release tag 标记版本，例如 `postgres-16.10-pgvector-0.8.0`。
- 主仓库 workflow 后续可以固定 checkout 某个 tag，避免二进制资源变化导致同一份代码构建结果不一致。

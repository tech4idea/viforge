# macOS（Apple Silicon）桌面版构建与发布教程

本文面向把 ViForge 单机版打成 macOS 安装程序（DMG）的流程，重点覆盖 **M 系列芯片（Apple Silicon，arm64）**。核心原则与 Windows 指南一致：先准备好 `darwin-arm64` 平台的 PostgreSQL + pgvector 资源包，再运行 Electron Builder 生成 DMG，最后按需完成代码签名与公证。

配套阅读：

- Windows 版流程：[19 单机桌面版构建与发布教程](./19-desktop-release-guide.md)
- 私有二进制 bundle 方案：[20 私有 GitHub 二进制资源仓库与 Actions 打包方案](./20-private-binary-bundle-github-actions.md)
- 版本管理：[ViForge 版本管理与发布指南](../guides/version-management-and-release.md)

## 1. 是否必须在对应平台构建

macOS DMG 强烈建议在 macOS 机器或 GitHub Actions `macos-latest`（当前为 M1 arm64 runner）上构建，原因：

- PostgreSQL binary、pgvector 扩展、动态库（`.dylib`）都是平台和架构相关的原生产物。
- Apple Silicon（arm64）和 Intel（x64）的二进制不能混用，交叉编译 PostgreSQL + pgvector 在 macOS 上不可靠。
- 代码签名和公证必须在 macOS 环境执行，依赖 `codesign` 和 `notarytool`。
- electron-builder 虽然支持在部分场景下交叉打多架构包，但正式 release 不建议依赖。

因此：

- M 芯片包：在 Apple Silicon 机器或 `macos-latest`（arm64）runner 上构建。
- Intel 包：在 Intel 机器或 `macos-13`（x64）runner 上构建（本文不作为重点）。

## 2. 目标架构说明

当前桌面端代码已支持 arm64 自动识别：

- `apps/desktop/src/main.ts` 的 `platformArch()` 在 M 芯片 mac 上返回 `darwin-arm64`，并据此定位 `resources/postgres/darwin-arm64/bin`。
- `prepare-postgres.mjs` 通过 `process.arch === 'arm64'` 自动识别主机架构。
- `electron-builder.config.mjs` 的 `mac.target` 已配置为 `['dmg']`。

建议在 `mac` 配置中显式锁定 `arch: ['arm64']`，避免在 Intel mac 上误打 x64 包或触发 universal 合并：

```js
mac: {
  target: ['dmg'],
  icon: 'build/icon.png',
  arch: ['arm64'],
},
```

## 3. macOS 本地验证建议

提交和推送前，至少在一台 Apple Silicon mac 上做一次验证，确认 DMG 可以打开、内置 PostgreSQL 可以启动、运行设置页面能保存模型配置。

如果没有 mac 环境，可以提交到 GitHub，用 `macos-latest` runner 构建。CI 只能证明"能构建"，不能完全替代人工打开应用验证签名、公证和 Gatekeeper 行为。

## 4. 准备基础环境

macOS 本地需要：

1. macOS 12+（Monterey 或更高，建议 macOS 14 Sonoma）。
2. Node.js 22。
3. pnpm。
4. Git。
5. **Xcode Command Line Tools**，用于编译 PostgreSQL/pgvector 时使用 clang 工具链。

安装 Xcode Command Line Tools：

```bash
xcode-select --install
```

验证：

```bash
clang --version
make --version
```

安装项目依赖：

```bash
pnpm install
```

## 5. 准备 PostgreSQL binary（darwin-arm64）

桌面版不要求用户预装 PostgreSQL，但安装包里必须内置一份 `darwin-arm64` 的 PostgreSQL binary。资源目录约定为：

```text
apps/desktop/resources/postgres/darwin-arm64/
```

目录里至少需要：

```text
bin/initdb
bin/pg_ctl
bin/postgres
bin/createdb
bin/psql
bin/pg_config          # 编译 pgvector 时需要
lib/
share/
```

推荐三种来源：

### 方式 A：从官方源码编译（推荐，可重定位）

源码编译脚本支持 macOS，使用 `./configure --prefix=... && make && make install` 产出可重定位目录。

```bash
# 1. 下载并解压 PostgreSQL 官方稳定版源码
#    https://www.postgresql.org/ftp/source/
#    例如 postgresql-16.10

# 2. 指向源码根目录并编译
export VIFORGE_POSTGRES_SOURCE_DIR=/path/to/postgresql-16.10
export VIFORGE_POSTGRES_PLATFORM_ARCH=darwin-arm64
pnpm --filter @viforge/desktop build:postgres
```

脚本会执行：

```bash
./configure --prefix=<install-root> \
  --without-readline --without-zlib --without-icu \
  --without-ldap --without-pam --without-openssl
make -j$(sysctl -n hw.ncpu)
make install
```

完成后产物会被复制到 `apps/desktop/resources/postgres/darwin-arm64/`。

注意事项：

- macOS 上必须先装好 Xcode Command Line Tools，否则 `configure` 会找不到编译器。
- `--without-icu` 等参数与 Linux 构建保持一致，减少对外部库的依赖，便于打包。
- 不要使用 Homebrew 安装的 PostgreSQL，因为它链接到 `/opt/homebrew` 下的系统库，复制到别的机器上会因路径不匹配而无法启动。

### 方式 B：从 GitHub Release 下载预编译 bundle

`prepare:postgres` 脚本支持在资源目录缺失时自动从 GitHub Release 下载匹配平台的 bundle。默认仓库是：

```text
YukeonWayne/pg_pgvector_binary
```

`darwin-arm64` 会查找 release asset 名称里包含 `darwin-arm64` 的 `.zip`，例如：

```text
postgres-18.4-pgvector-0.8.3-darwin-arm64.zip
```

下载并准备：

```bash
export VIFORGE_POSTGRES_PLATFORM_ARCH=darwin-arm64
export VIFORGE_REQUIRE_PGVECTOR=1
export VIFORGE_POSTGRES_BUNDLE_RELEASE_REPO=YukeonWayne/pg_pgvector_binary
export VIFORGE_POSTGRES_BUNDLE_RELEASE_TAG=v18.4-pgvector0.8.3-darwin-arm64
export VIFORGE_POSTGRES_BUNDLE_ASSET_NAME=postgres-18.4-pgvector-0.8.3-darwin-arm64.zip
pnpm --filter @viforge/desktop prepare:postgres
```

如果 release asset 带有 `sha256:` digest，脚本会自动校验；也可以显式覆盖：

```bash
export VIFORGE_POSTGRES_BUNDLE_SHA256=<expected-sha256>
```

如果仓库或 release 是私有的，设置 `VIFORGE_POSTGRES_BUNDLE_GITHUB_TOKEN` 或 `GITHUB_TOKEN`，token 只需要 release 资源读取权限。

### 方式 C：手动复制

从官方 macOS 安装包或可信来源提取 PostgreSQL 根目录后，直接复制到资源目录：

```bash
cp -R /path/to/postgresql-root apps/desktop/resources/postgres/darwin-arm64
```

再用 `prepare:postgres` 做一次校验：

```bash
export VIFORGE_POSTGRES_PLATFORM_ARCH=darwin-arm64
pnpm --filter @viforge/desktop prepare:postgres
```

不要依赖来路不明的第三方 binary。

## 6. 准备 pgvector

LangGraph Store 的语义检索需要 pgvector。正式安装包建议包含 pgvector，否则应用会退化为 PostgreSQL 文本检索。

源码编译脚本支持 macOS，使用 `pg_config` 定位 PostgreSQL 安装路径：

```bash
# 1. 下载 pgvector release 源码，例如 v0.8.0
#    https://github.com/pgvector/pgvector/releases

# 2. 指向源码根目录并编译（必须先完成 PostgreSQL 的准备）
export VIFORGE_PGVECTOR_SOURCE_DIR=/path/to/pgvector-0.8.0
export VIFORGE_POSTGRES_PLATFORM_ARCH=darwin-arm64
pnpm --filter @viforge/desktop build:pgvector
```

脚本会使用 `apps/desktop/resources/postgres/darwin-arm64/bin/pg_config` 编译并安装 pgvector。完成后应能看到：

```text
apps/desktop/resources/postgres/darwin-arm64/share/extension/vector.control
apps/desktop/resources/postgres/darwin-arm64/lib/vector.so
```

发布前建议强制检查 pgvector：

```bash
export VIFORGE_REQUIRE_PGVECTOR=1
export VIFORGE_POSTGRES_PLATFORM_ARCH=darwin-arm64
pnpm --filter @viforge/desktop prepare:postgres
```

`prepare:postgres` 还会把 `vector.so` 从 `16/lib/` 归一化到 `lib/`（如果存在嵌套目录），确保运行时能正确加载扩展。

## 7. 构建目录版（.app）

目录版适合本地快速验证，不生成 DMG 安装器：

```bash
pnpm desktop:pack
```

macOS 输出目录通常在：

```text
release/desktop/mac-arm64/
```

打开 `ViForge.app` 验证。由于未签名，首次打开会被 Gatekeeper 拦截，处理方式见第 10 节。

验证清单：

1. 应用窗口能启动。
2. 不需要用户预装 Node 或 PostgreSQL。
3. 首次启动会弹出数据路径选择对话框（macOS 没有 NSIS 安装向导，数据路径在应用首次启动时通过 Electron `dialog.showOpenDialog` 选择）。
4. 数据路径写入 `~/Library/Application Support/ViForge/data-root.txt`。
5. API 和内置 PostgreSQL 启动期间会显示"ViForge 正在打开"占位窗口。
6. 重复点击 Dock 图标不会启动第二个实例，只会聚焦当前窗口（单实例锁）。
7. 点击窗口关闭按钮会弹出确认框，可选择"仅关闭窗口"或"完全退出"。
8. Cmd+Q 会触发完全退出，停止后台 API 和 PostgreSQL。
9. 运行设置页面能打开，并显示当前数据路径。
10. 默认数据库模式是内置 PostgreSQL。
11. 填写 OpenAI 协议 Base URL、API Key、模型后能保存。

## 8. 构建 DMG 安装包

macOS 一键 DMG 安装包：

```bash
pnpm desktop:dist
```

输出目录：

```text
release/desktop/
```

当前 `electron-builder.config.mjs` 的 `mac` 配置：

```js
mac: {
  target: ['dmg'],
  icon: 'build/icon.png',
},
```

建议补充 `arch` 和 `artifactName`，使产物命名与 Windows 保持一致，并方便 release manifest 校验：

```js
mac: {
  target: ['dmg'],
  icon: 'build/icon.png',
  arch: ['arm64'],
  artifactName: buildReleaseArtifactFileName({
    productName,
    version: releaseVersion,
    channel: releaseChannel,
    platform: 'darwin-arm64',
    qualifier: 'installer',
    extension: 'dmg',
  }),
},
```

DMG 安装方式：用户打开 DMG 后，将 `ViForge.app` 拖入 `Applications` 文件夹即可。数据路径在首次启动应用时选择，不依赖安装器写入。

## 9. 代码签名与公证（正式分发必须）

macOS 分发未签名的应用给普通用户时，Gatekeeper 会阻止打开并提示"无法验证开发者"。正式 release 必须完成签名和公证。

### 9.1 前置条件

1. **Apple Developer Program 账号**（付费）。
2. **Developer ID Application 证书**：在 https://developer.apple.com/account 签发，用于 App Store 外分发。
3. 记下 **Team ID**（10 位字符，例如 `ABCDE12345`）。
4. 创建 **App-specific password**：在 https://appleid.apple.com 生成，用于 `notarytool` 公证。

### 9.2 导入签名证书

将 Developer ID Application 证书导入到 mac 钥匙串：

```bash
# 方式一：从 .p12 文件导入
security import developer-id.p12 -k ~/Library/Keychains/login.keychain-db -P <password> -T /usr/bin/codesign

# 方式二：通过 Xcode 自动同步
# Xcode -> Settings -> Accounts -> Download Manual Profiles
```

验证证书可用：

```bash
security find-identity -v -p codesigning
# 应能看到 "Developer ID Application: <your name> (<TeamID>)"
```

### 9.3 准备 entitlements 文件

签名时需要声明 entitlements。ViForge 桌面端会 spawn 子进程（API、PostgreSQL、Playwriter），至少需要以下能力。在 `apps/desktop/build/entitlements.mac.plist` 创建：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
  <key>com.apple.security.cs.allow-dyld-environment-variables</key>
  <true/>
  <key>com.apple.security.network.client</key>
  <true/>
  <key>com.apple.security.network.server</key>
  <true/>
</dict>
</plist>
```

说明：

- `allow-jit` / `allow-unsigned-executable-memory`：Electron / Node 运行时需要。
- `disable-library-validation`：内置 PostgreSQL binary 和 pgvector 的 `.dylib` 不是由同一团队签名，必须关闭库校验。
- `network.client` / `network.server`：API 监听本地端口，且需要访问外部模型服务。

### 9.4 配置 electron-builder 签名与公证

更新 `electron-builder.config.mjs` 的 `mac` 配置：

```js
mac: {
  target: ['dmg'],
  icon: 'build/icon.png',
  arch: ['arm64'],
  hardenedRuntime: true,
  entitlements: 'build/entitlements.mac.plist',
  entitlementsInherit: 'build/entitlements.mac.plist',
  gatekeeperAssess: false,
  notarize: {
    teamId: process.env.APPLE_TEAM_ID,
  },
},
```

### 9.5 设置签名与公证环境变量

构建时注入：

```bash
# 签名证书（electron-builder 默认从钥匙串自动查找 Developer ID Application）
export CSC_NAME="Developer ID Application: <your name> (<TeamID>)"
# 或用 CSC_LINK 指向 .p12 文件
# export CSC_LINK=file:///path/to/developer-id.p12
# export CSC_KEY_PASSWORD=<p12-password>

# 公证所需
export APPLE_ID=<your-apple-id@email.com>
export APPLE_APP_SPECIFIC_PASSWORD=<app-specific-password>
export APPLE_TEAM_ID=<TeamID>
```

### 9.6 构建并公证

```bash
pnpm desktop:dist
```

electron-builder 会在生成 DMG 后自动执行：

1. 使用 `codesign` 对 `.app` 内所有可执行文件和库进行签名（hardened runtime）。
2. 将 `.app` 打包成 zip 提交给 Apple `notarytool`。
3. 轮询公证结果（通常 5-15 分钟）。
4. 公证通过后，将票据 staple 到 `.app`（`xcrun stapler staple`）。
5. 生成最终 DMG。

验证签名和公证状态：

```bash
# 检查签名
codesign --verify --deep --strict --verbose=2 "release/desktop/mac-arm64/ViForge.app"

# 检查公证票据
xcrun stapler validate "release/desktop/mac-arm64/ViForge.app"

# 检查 Gatekeeper 评估结果
spctl --assess --type execute --verbose "release/desktop/mac-arm64/ViForge.app"
```

正常输出应包含 `accepted`。

## 10. Gatekeeper 与分发注意事项

### 10.1 未签名版本（内部测试）

未签名的 `.app` 和 DMG 首次打开会被 Gatekeeper 拦截。处理方式：

```bash
# 方式一：移除隔离属性（推荐，最干净）
xattr -cr /path/to/ViForge.app

# 方式二：在 Finder 中右键 -> 打开，在弹窗里确认"打开"
```

DMG 本身也可能带隔离属性，拖拽安装后仍需对 `.app` 执行一次 `xattr -cr`。

### 10.2 App Translocation

macOS 会对带隔离属性的未签名应用触发 **App Translocation**：应用被复制到一个随机化的只读路径下运行，导致内置 PostgreSQL 数据路径、资源路径异常。签名 + 公证可以彻底避免此问题。未签名版本必须在拖入 `Applications` 后执行 `xattr -cr`。

### 10.3 公证失败排查

```bash
# 查看公证详细日志（notarytool 会返回 RequestUUID）
xcrun notarytool log <RequestUUID> \
  --apple-id <apple-id> \
  --password <app-specific-password> \
  --team-id <TeamID>
```

常见原因：

- 忘记对内置 PostgreSQL binary 或 `.dylib` 签名（electron-builder 会递归签名，但手动放入的资源需确认）。
- entitlements 缺少 `disable-library-validation`，导致加载 pgvector `vector.so` 失败。
- hardened runtime 未启用。

## 11. 更新 releaseManifest

正式发布前，在 `packages/shared/src/releaseManifest.ts` 的 `artifacts` 数组中追加 macOS 制品定义。共享合同 `ReleaseArtifact.platform` 已支持 `macos-arm64`，`target` 已支持 `dmg`：

```ts
artifacts: [
  // ... 既有 Windows 制品
  {
    platform: 'macos-arm64',
    fileName: buildReleaseArtifactFileName({
      productName: RELEASE_PRODUCT_NAME,
      version: RELEASE_VERSION,
      channel: RELEASE_CHANNEL,
      platform: 'darwin-arm64',
      qualifier: 'installer',
      extension: 'dmg',
    }),
    target: 'dmg',
  },
],
```

这样 `/api/release-info` 会返回当前平台匹配的制品文件名，前端运行设置面板可据此展示下载入口。

## 12. GitHub Actions 构建建议

建议为 macOS 单独创建 workflow 文件 `.github/workflows/desktop-macos.yml`，每平台独立 job。`macos-latest` 当前为 M1 arm64 runner，适合打 Apple Silicon 包。

参考 Windows workflow，macOS 版核心差异：

- `runs-on: macos-latest`
- `VIFORGE_POSTGRES_PLATFORM_ARCH: darwin-arm64`
- bundle asset 名称包含 `darwin-arm64`
- 上传 `*.dmg`、`*.blockmap`、`latest*.yml`
- 如需签名公证，注入 `APPLE_*` 和 `CSC_*` secrets

最小可运行 workflow（无签名公证，仅构建）：

```yaml
name: Desktop macOS

on:
  workflow_dispatch:
    inputs:
      bundle_release_tag:
        description: GitHub Release tag from YukeonWayne/pg_pgvector_binary
        required: false
        default: v18.4-pgvector0.8.3-darwin-arm64

permissions:
  contents: read

jobs:
  build-macos:
    name: Build macOS desktop installer (Apple Silicon)
    runs-on: macos-latest
    timeout-minutes: 90

    env:
      VIFORGE_POSTGRES_PLATFORM_ARCH: darwin-arm64
      VIFORGE_REQUIRE_PGVECTOR: '1'
      VIFORGE_RELEASE_COMMIT: ${{ github.sha }}
      VIFORGE_POSTGRES_BUNDLE_RELEASE_REPO: YukeonWayne/pg_pgvector_binary
      VIFORGE_POSTGRES_BUNDLE_RELEASE_TAG: ${{ inputs.bundle_release_tag || 'v18.4-pgvector0.8.3-darwin-arm64' }}
      VIFORGE_POSTGRES_BUNDLE_ASSET_NAME: postgres-18.4-pgvector-0.8.3-darwin-arm64.zip

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

      - name: Read release metadata
        id: release_meta
        run: node scripts/release-metadata.mjs --github-output

      - name: Install dependencies
        run: pnpm install --frozen-lockfile
        env:
          VIFORGE_RELEASE_VERSION: ${{ steps.release_meta.outputs.version }}
          VIFORGE_RELEASE_TAG: ${{ steps.release_meta.outputs.tag }}
          VIFORGE_RELEASE_CHANNEL: ${{ steps.release_meta.outputs.channel }}

      - name: Verify or download PostgreSQL bundle
        run: pnpm --filter @viforge/desktop prepare:postgres
        env:
          VIFORGE_RELEASE_VERSION: ${{ steps.release_meta.outputs.version }}
          VIFORGE_RELEASE_TAG: ${{ steps.release_meta.outputs.tag }}
          VIFORGE_RELEASE_CHANNEL: ${{ steps.release_meta.outputs.channel }}

      - name: Typecheck API
        run: pnpm --filter @viforge/api typecheck
        env:
          VIFORGE_RELEASE_VERSION: ${{ steps.release_meta.outputs.version }}
          VIFORGE_RELEASE_TAG: ${{ steps.release_meta.outputs.tag }}
          VIFORGE_RELEASE_CHANNEL: ${{ steps.release_meta.outputs.channel }}

      - name: Typecheck web
        run: pnpm --filter @viforge/web typecheck
        env:
          VIFORGE_RELEASE_VERSION: ${{ steps.release_meta.outputs.version }}
          VIFORGE_RELEASE_TAG: ${{ steps.release_meta.outputs.tag }}
          VIFORGE_RELEASE_CHANNEL: ${{ steps.release_meta.outputs.channel }}

      - name: Build macOS installer
        run: pnpm desktop:dist
        env:
          VIFORGE_RELEASE_VERSION: ${{ steps.release_meta.outputs.version }}
          VIFORGE_RELEASE_TAG: ${{ steps.release_meta.outputs.tag }}
          VIFORGE_RELEASE_CHANNEL: ${{ steps.release_meta.outputs.channel }}

      - name: Upload macOS artifacts
        uses: actions/upload-artifact@v7
        with:
          name: viforge-macos-desktop
          path: |
            release/desktop/*.dmg
            release/desktop/*.blockmap
            release/desktop/latest*.yml
          if-no-files-found: error
```

### 12.1 在 CI 中启用签名与公证

在 GitHub 仓库 `Settings -> Secrets and variables -> Actions` 新增以下 secrets：

```text
APPLE_ID=<apple-id@email.com>
APPLE_APP_SPECIFIC_PASSWORD=<app-specific-password>
APPLE_TEAM_ID=<TeamID>
CSC_NAME=Developer ID Application: <your name> (<TeamID>)
# 或使用 CSC_LINK + CSC_KEY_PASSWORD 指向 .p12
```

在 "Build macOS installer" 步骤注入：

```yaml
      - name: Build macOS installer (signed + notarized)
        run: pnpm desktop:dist
        env:
          VIFORGE_RELEASE_VERSION: ${{ steps.release_meta.outputs.version }}
          VIFORGE_RELEASE_TAG: ${{ steps.release_meta.outputs.tag }}
          VIFORGE_RELEASE_CHANNEL: ${{ steps.release_meta.outputs.channel }}
          CSC_NAME: ${{ secrets.CSC_NAME }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
```

公证步骤会使构建时间增加 5-15 分钟，建议 `timeout-minutes` 设为 90 以上。

## 13. 推送前检查清单

提交前建议确认：

```bash
git status --short
pnpm --filter @viforge/api typecheck
pnpm --filter @viforge/web typecheck
pnpm --filter @viforge/desktop build
pnpm --filter @viforge/api test -- runtimeConfig.test.ts desktopAccess.test.ts
pnpm desktop:pack
```

不要提交以下产物：

- `release/`
- `apps/web/dist/`
- `apps/desktop/dist/`
- `apps/desktop/resources/postgres/*/` 下的 PostgreSQL 运行数据
- `.env` 或 API Key
- Apple 证书、`.p12`、App-specific password

PostgreSQL binary bundle 目前被 `.gitignore` 排除，发布流程应通过 CI 下载/构建，或在本地构建安装包前临时放入资源目录。

## 14. 当前已知注意点

- 没有 pgvector 时应用仍能启动，但 LangGraph 长期记忆会退化为文本检索。正式包建议强制 `VIFORGE_REQUIRE_PGVECTOR=1`。
- Homebrew 安装的 PostgreSQL 不可直接复制进 bundle：它链接 `/opt/homebrew` 下的库，换机器后会因路径不匹配无法启动。必须用源码 `--prefix` 编译或官方可重定位发行版。
- macOS 上没有系统托盘（`apps/desktop/src/main.ts` 中 `ensureTray()` 对 `darwin` 直接返回），Dock 图标和菜单栏负责应用切换。
- macOS 上数据路径选择不依赖 NSIS 安装向导（`installer.nsh` 仅 Windows 生效），而是应用首次启动时通过 Electron `dialog.showOpenDialog` 选择。
- 未签名 + 未公证的 DMG 分发给普通用户会触发 Gatekeeper 拦截和 App Translocation，内部测试时需告知用户执行 `xattr -cr`，正式分发必须完成签名公证。
- Apple Silicon 上运行 Intel（x64）二进制需要 Rosetta 2；本指南只产出原生 arm64 包，不覆盖 universal binary。如需同时支持 Intel mac，建议在 `macos-13` runner 上单独打 x64 包。
- `electron-builder.config.mjs` 当前 `mac` 配置未设置 `artifactName`，DMG 会使用默认命名；正式发布前应补充命名规则以匹配 `releaseManifest`。

# feature-mac-package-build-20260718 分支分析结论

> 分析目标：评估该分支新增改动能否满足把 ViForge 单机版打成 macOS 安装程序（DMG）的流程需求。
>
> 对比基准：`main` 分支（merge-base `3a62f24`）

## 总体评估

**基本满足。** 该分支覆盖了从 CI 构建到签名公证的完整链路，但存在少量需注意的外部依赖和细节问题。

## 分支改动概览

分支包含 2 个提交，涉及 6 个文件（+789 行）：

| 文件 | 类型 | 作用 |
|------|------|------|
| `.github/workflows/desktop-macos.yml` | 新增 | macOS CI 构建流水线 |
| `apps/desktop/build/entitlements.mac.plist` | 新增 | 签名所需 entitlements 声明 |
| `apps/desktop/electron-builder.config.mjs` | 修改 | 补充 `arch`、`artifactName`、条件签名/公证 |
| `docs/current/22-mac-desktop-release-guide.md` | 新增 | 643 行完整构建发布教程 |
| `docs/current/README.md` | 修改 | 文档索引新增条目 |
| `packages/shared/src/releaseManifest.ts` | 修改 | 新增 `macos-arm64` / `dmg` 制品定义 |

## 已满足的关键需求

1. **CI 流水线完整**：workflow 结构对齐 Windows 版，包含 checkout → pnpm → Node → release metadata → install → prepare:postgres → typecheck → build → upload artifact，且注入了签名 secrets。
2. **electron-builder mac 配置到位**：`arch: ['arm64']` 锁定架构，`artifactName` 与 `releaseManifest` 命名一致，`shouldSignMacBuild()` 实现有证书时自动启用 hardenedRuntime + notarize。
3. **Entitlements 正确**：包含 JIT、unsigned memory、disable-library-validation（pgvector `.dylib` 需要）、dyld env、network client/server。
4. **运行时已兼容 darwin-arm64**（main 分支既有代码）：
   - `apps/desktop/src/main.ts` 的 `platformArch()` 返回 `darwin-arm64`
   - `apps/desktop/scripts/prepare-postgres.mjs` 支持 darwin 平台识别和 bundle 下载
   - `apps/desktop/scripts/build-postgres-from-source.mjs` 支持 macOS 源码编译
   - `ensureTray()` 对 darwin 直接跳过
5. **共享合同已支持**：`packages/shared/src/contracts.ts` 中 `ReleaseArtifact.platform` 已含 `'macos-arm64'`，`target` 已含 `'dmg'`。
6. **图标链路通**：`prepare-icons.mjs` 在 `pnpm build` 时生成 512×512 `icon.png`，electron-builder 可自动转 ICNS。

## 需关注的风险 / 不足

| # | 问题 | 影响 | 建议 |
|---|------|------|------|
| 1 | **PostgreSQL darwin-arm64 bundle 是否已发布？** workflow 依赖 `YukeonWayne/pg_pgvector_binary` 仓库的 `v18.4-pgvector0.8.3-darwin-arm64` release asset | 若 asset 不存在，CI 会在 `prepare:postgres` 步骤失败 | 确认该 release 已上传 `postgres-18.4-pgvector-0.8.3-darwin-arm64.zip` |
| 2 | **文档第 14 节最后一条过时**：写着"mac 配置未设置 artifactName"，但代码已添加 | 文档与代码不一致，可能误导读者 | 删除或更新该条 |
| 3 | **DMG 无自定义外观**（无 background、iconSize、窗口尺寸配置） | 用户打开 DMG 看到的是默认布局，不影响功能但体验一般 | 后续可加 `dmg: { background, contents }` 配置 |
| 4 | **仅覆盖 arm64**，不支持 Intel mac | 文档已明确说明，非缺陷 | 如需 Intel 支持，另开 `macos-13` runner 打 x64 包 |
| 5 | **workflow 中签名 secrets 未做 optional 保护**：若仓库未配置 `CSC_NAME` 等 secrets，`${{ secrets.X }}` 会注入空字符串 | `shouldSignMacBuild()` 会返回 false 从而跳过签名，不会报错——逻辑上安全 | 无需修改，但建议在 README 中注明首次运行可不配签名 |
| 6 | **无 `afterSign` / `afterPack` 钩子验证 PostgreSQL binary 签名** | electron-builder 默认会递归签名 extraResources 内的可执行文件，一般够用 | 若公证失败再排查 |

## 结论

该分支的改动**能够满足**把 ViForge 单机版打成 macOS（Apple Silicon）DMG 安装程序的核心流程需求——包括本地构建、CI 自动构建、代码签名与公证、制品命名与 release manifest 对齐。

**唯一硬性外部前提**是 `darwin-arm64` 的 PostgreSQL + pgvector 预编译 bundle 已发布到指定 GitHub Release 仓库。

建议合并前：

1. 确认 `YukeonWayne/pg_pgvector_binary` 仓库中 `v18.4-pgvector0.8.3-darwin-arm64` release 及对应 zip asset 存在。
2. 修正 `docs/current/22-mac-desktop-release-guide.md` 第 14 节关于 `artifactName` 的过时描述。

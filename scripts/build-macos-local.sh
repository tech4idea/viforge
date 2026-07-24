#!/usr/bin/env bash
#
# ViForge macOS (Apple Silicon) 本地构建验证脚本
# 用途：在 Apple Silicon Mac 上从源码编译 PostgreSQL + pgvector，然后构建 DMG 安装包
#
# 使用方式：
#   chmod +x scripts/build-macos-local.sh
#   ./scripts/build-macos-local.sh
#
# 可选环境变量：
#   VIFORGE_POSTGRES_VERSION   PostgreSQL 版本（默认 16.10）
#   VIFORGE_PGVECTOR_VERSION   pgvector 版本（默认 0.8.3）
#   VIFORGE_BUILD_DIR          编译工作目录（默认 /tmp/viforge-macos-build）
#   VIFORGE_SKIP_PGVECTOR      设为 1 跳过 pgvector 编译
#

set -euo pipefail

POSTGRES_VERSION="${VIFORGE_POSTGRES_VERSION:-16.10}"
PGVECTOR_VERSION="${VIFORGE_PGVECTOR_VERSION:-0.8.3}"
BUILD_DIR="${VIFORGE_BUILD_DIR:-/tmp/viforge-macos-build}"
PLATFORM_ARCH="darwin-arm64"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

log() { echo "==> $*"; }
warn() { echo "!!! $*"; }
fail() { echo "!!! ERROR: $*" >&2; exit 1; }

# ── 0. 前置检查 ──────────────────────────────────────────────────

log "检查前置条件..."

[ "$(uname -s)" = "Darwin" ] || fail "此脚本仅支持 macOS"
[ "$(uname -m)" = "arm64" ]  || warn "当前架构为 $(uname -m)，非 arm64，构建结果可能不适用于本机"

command -v xcode-select &>/dev/null || fail "未找到 xcode-select，请先运行: xcode-select --install"
command -v clang &>/dev/null        || fail "未找到 clang，请先运行: xcode-select --install"
command -v node &>/dev/null          || fail "未找到 Node.js，请安装 Node.js 22+"
command -v pnpm &>/dev/null          || fail "未找到 pnpm，请运行: npm install -g pnpm"

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 22 ]; then
  warn "Node.js 版本 $(node -v)，建议使用 22+"
fi

log "前置条件通过"

# ── 1. 准备编译目录 ──────────────────────────────────────────────

mkdir -p "$BUILD_DIR"
log "编译工作目录: $BUILD_DIR"

# ── 2. 下载并编译 PostgreSQL ────────────────────────────────────

PG_SOURCE_DIR="$BUILD_DIR/postgresql-$POSTGRES_VERSION"

if [ -d "$REPO_ROOT/apps/desktop/resources/postgres/$PLATFORM_ARCH/bin" ]; then
  log "检测到已有 PostgreSQL bundle，跳过编译"
else
  if [ ! -d "$PG_SOURCE_DIR" ]; then
    log "下载 PostgreSQL $POSTGRES_VERSION 源码..."
    PG_TARBALL="$BUILD_DIR/postgresql-$POSTGRES_VERSION.tar.gz"
    if [ ! -f "$PG_TARBALL" ]; then
      curl -fSL -o "$PG_TARBALL" \
        "https://ftp.postgresql.org/pub/source/v${POSTGRES_VERSION}/postgresql-${POSTGRES_VERSION}.tar.gz"
    fi
    log "解压 PostgreSQL 源码..."
    tar xzf "$PG_TARBALL" -C "$BUILD_DIR"
  fi

  log "编译 PostgreSQL (这需要几分钟)..."
  export VIFORGE_POSTGRES_SOURCE_DIR="$PG_SOURCE_DIR"
  export VIFORGE_POSTGRES_PLATFORM_ARCH="$PLATFORM_ARCH"
  pnpm --filter @viforge/desktop build:postgres
  log "PostgreSQL 编译完成"
fi

# ── 3. 下载并编译 pgvector ──────────────────────────────────────

if [ "${VIFORGE_SKIP_PGVECTOR:-0}" = "1" ]; then
  warn "跳过 pgvector 编译（VIFORGE_SKIP_PGVECTOR=1）"
else
  PGVECTOR_SOURCE_DIR="$BUILD_DIR/pgvector-$PGVECTOR_VERSION"

  if [ ! -d "$PGVECTOR_SOURCE_DIR" ]; then
    log "下载 pgvector $PGVECTOR_VERSION 源码..."
    PGVECTOR_TARBALL="$BUILD_DIR/pgvector-$PGVECTOR_VERSION.tar.gz"
    if [ ! -f "$PGVECTOR_TARBALL" ]; then
      curl -fSL -o "$PGVECTOR_TARBALL" \
        "https://github.com/pgvector/pgvector/archive/refs/tags/v${PGVECTOR_VERSION}.tar.gz"
    fi
    log "解压 pgvector 源码..."
    tar xzf "$PGVECTOR_TARBALL" -C "$BUILD_DIR"
  fi

  log "编译 pgvector..."
  export VIFORGE_PGVECTOR_SOURCE_DIR="$PGVECTOR_SOURCE_DIR"
  export VIFORGE_POSTGRES_PLATFORM_ARCH="$PLATFORM_ARCH"
  pnpm --filter @viforge/desktop build:pgvector
  log "pgvector 编译完成"
fi

# ── 4. 校验 PostgreSQL bundle ──────────────────────────────────

log "校验 PostgreSQL bundle..."
export VIFORGE_POSTGRES_PLATFORM_ARCH="$PLATFORM_ARCH"

if [ "${VIFORGE_SKIP_PGVECTOR:-0}" = "1" ]; then
  pnpm --filter @viforge/desktop prepare:postgres
else
  VIFORGE_REQUIRE_PGVECTOR=1 pnpm --filter @viforge/desktop prepare:postgres
fi

log "PostgreSQL bundle 校验通过"

# ── 5. Typecheck ────────────────────────────────────────────────

log "Typecheck API..."
pnpm --filter @viforge/api typecheck

log "Typecheck Web..."
pnpm --filter @viforge/web typecheck

log "Typecheck 通过"

# ── 6. 构建目录版（快速验证）────────────────────────────────────

log "构建目录版 .app（用于快速验证）..."
pnpm desktop:pack

APP_PATH="$REPO_ROOT/release/desktop/mac-arm64/ViForge.app"
if [ -d "$APP_PATH" ]; then
  log "目录版构建成功: $APP_PATH"
  log ""
  log "验证 .app 是否可以打开..."
  open "$APP_PATH" || true
  log ""
else
  fail "目录版构建失败，未找到: $APP_PATH"
fi

# ── 7. 构建 DMG 安装包 ──────────────────────────────────────────

log "构建 DMG 安装包..."
pnpm desktop:dist

DMG_FILES=$(find "$REPO_ROOT/release/desktop" -name "*.dmg" -type f 2>/dev/null)
if [ -n "$DMG_FILES" ]; then
  log "DMG 构建成功:"
  echo "$DMG_FILES" | while read -r f; do
    log "  $f ($(du -h "$f" | cut -f1))"
  done
else
  fail "DMG 构建失败，未找到 .dmg 文件"
fi

# ── 8. 完成 ─────────────────────────────────────────────────────

log ""
log "========================================="
log "  构建完成！"
log "========================================="
log ""
log "目录版: $APP_PATH"
log "DMG 文件:"
echo "$DMG_FILES" | while read -r f; do
  log "  $f"
done
log ""
log "未签名版本使用须知："
log "  首次打开前需执行: xattr -cr $APP_PATH"
log "  DMG 安装后需执行: xattr -cr /Applications/ViForge.app"
log ""
log "验证检查清单："
log "  [ ] 应用窗口正常启动"
log "  [ ] 不要求预装 Node 或 PostgreSQL"
log "  [ ] 首次启动弹出数据路径选择对话框"
log "  [ ] 启动期间显示占位窗口"
log "  [ ] Dock 图标重复点击不会启动第二个实例"
log "  [ ] 关闭窗口有确认框"
log "  [ ] Cmd+Q 完全退出"
log "  [ ] 运行设置页面能打开"
log "  [ ] 填写模型配置后能保存"
log ""

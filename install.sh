#!/bin/bash
# mimodex 安装脚本
#
#   bash install.sh                     # 交互式输入 MiMo API key
#   MIMO_API_KEY=tp-xxx bash install.sh # 从环境变量取
#   bash install.sh --token tp-xxx      # 从参数取
#
# 本脚本只做三件事，且**不碰 ~/.codex/config.toml**：
#   1. 生成本地运行时配置 config.json（从 config.example.json）
#   2. 把 MiMo API key 写到 ~/.codex/mimodex-token（mode 600）
#   3. 把 bin/mimodex 链接到 ~/.local/bin/mimodex
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd -P)"
BIN_DIR="${MIMODEX_BIN_DIR:-$HOME/.local/bin}"
TOKEN_FILE="${MIMODEX_TOKEN_FILE:-$HOME/.codex/mimodex-token}"
CATALOG="${MIMODEX_CATALOG:-$HOME/.codex/model-catalog-mimo.json}"

say()  { echo "[install] $*"; }
warn() { echo "[install] $*" >&2; }
die()  { echo "[install] 错误：$*" >&2; exit 1; }

TOKEN="${MIMO_API_KEY:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="${2:-}"; shift 2 ;;
    --token=*) TOKEN="${1#*=}"; shift ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "未知参数 $1" ;;
  esac
done

# ---------- 依赖检查 ----------
say "检查依赖"
command -v node  >/dev/null 2>&1 || die "未找到 node（需要 Node 18+，推荐 22+）"
command -v codex >/dev/null 2>&1 || die "未找到 codex（先安装 Codex CLI）"
say "  node  $(node --version)"
say "  codex $(codex --version 2>/dev/null | tail -1)"

# ---------- 运行时配置 ----------
if [ -f "$ROOT/config.json" ]; then
  say "config.json 已存在，保留不动"
else
  cp "$ROOT/config.example.json" "$ROOT/config.json"
  say "已从 config.example.json 生成 config.json"
fi

# ---------- 凭据 ----------
if [ -z "$TOKEN" ]; then
  if [ -r "$TOKEN_FILE" ] && [ -s "$TOKEN_FILE" ]; then
    say "已存在凭据文件 ${TOKEN_FILE}，保留不动"
  else
    printf '请输入 MiMo API key（输入时不回显）: ' >&2
    read -rs TOKEN
    echo >&2
  fi
fi
if [ -n "$TOKEN" ]; then
  mkdir -p "$(dirname "$TOKEN_FILE")"
  ( umask 077; printf '%s\n' "$TOKEN" > "$TOKEN_FILE" )
  chmod 600 "$TOKEN_FILE"
  say "凭据已写入 $TOKEN_FILE (mode 600)"
fi
[ -s "$TOKEN_FILE" ] || die "凭据文件为空：$TOKEN_FILE"

# ---------- 命令 ----------
mkdir -p "$BIN_DIR"
ln -sfn "$ROOT/bin/mimodex" "$BIN_DIR/mimodex"
chmod +x "$ROOT/bin/mimodex"
say "命令已安装：$BIN_DIR/mimodex -> $ROOT/bin/mimodex"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "注意：$BIN_DIR 不在 PATH 上，需要自行加入" ;;
esac

# ---------- 模型目录 ----------
if [ -f "$CATALOG" ]; then
  say "发现模型目录 $CATALOG"
  if grep -q '"gpt-6-astra"' "$CATALOG" 2>/dev/null; then
    say "  已包含 mimodex 所需的别名条目，跳过"
  else
    say "  尚未打补丁，执行 tools/patch-catalog.py"
    node --version >/dev/null 2>&1 || true
    if command -v python3 >/dev/null 2>&1; then
      python3 "$ROOT/tools/patch-catalog.py" "$CATALOG" || warn "  补丁失败，可手动运行 tools/patch-catalog.py"
    else
      warn "  未找到 python3，请手动运行 tools/patch-catalog.py"
    fi
  fi
else
  warn "未找到模型目录 $CATALOG"
  warn "请先从小米官方获取 MiMo 的 Codex 模型目录（model-catalogs.json），"
  warn "放到该路径后再运行：python3 tools/patch-catalog.py $CATALOG"
fi

# ---------- 完成 ----------
say "完成。"
echo
echo "  mimodex                     启动 codex（MiMo 后端）"
echo "  mimodex exec \"...\"          非交互执行"
echo "  mimodex proxy start         启动适配代理"
echo "  mimodex check               自检"
echo
echo "  普通 codex 与 ChatGPT App 不受影响，仍读它们原本的 ~/.codex/config.toml。"

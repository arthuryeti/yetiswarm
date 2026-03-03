#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_SKILL="$ROOT_DIR/SKILL.md"
SRC_SCRIPTS="$ROOT_DIR/scripts"

expand_home() {
  local input
  input="$1"

  case "$input" in
    "~")
      printf '%s\n' "$HOME"
      ;;
    "~/"*)
      printf '%s\n' "$HOME/${input#~/}"
      ;;
    *)
      printf '%s\n' "$input"
      ;;
  esac
}

resolve_path() {
  local input base expanded
  input="$1"
  base="$2"
  expanded="$(expand_home "$input")"

  case "$expanded" in
    /*)
      printf '%s\n' "$expanded"
      ;;
    *)
      printf '%s\n' "$base/$expanded"
      ;;
  esac
}

confirm_yes() {
  local prompt reply
  prompt="$1"
  read -r -p "$prompt [Y/n] " reply
  case "$reply" in
    ""|y|Y|yes|YES)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

sync_scripts_dir() {
  local src_dir dest_dir
  src_dir="$1"
  dest_dir="$2"

  if command -v rsync >/dev/null 2>&1; then
    mkdir -p "$dest_dir"
    rsync -a --delete \
      --exclude '.DS_Store' \
      "$src_dir/" "$dest_dir/"
    return 0
  fi

  rm -rf "$dest_dir"
  mkdir -p "$dest_dir"
  cp -R "$src_dir/." "$dest_dir/"
}

if [ ! -f "$SRC_SKILL" ]; then
  echo "Source SKILL.md not found: $SRC_SKILL" >&2
  exit 1
fi

if [ ! -d "$SRC_SCRIPTS" ]; then
  echo "Source scripts directory not found: $SRC_SCRIPTS" >&2
  exit 1
fi

default_base_raw="${OPENCLAW_SKILLS_DIR:-~/.agents/skills}"
default_dest_raw="${default_base_raw%/}/yetiswarm"

echo ""
echo "(=^.^=) yetiswarm installer"
echo ""
echo "This installs a flat skill package:"
echo "  SKILL.md"
echo "  scripts/*"
echo ""

read -r -p "Install directory [$default_dest_raw]: " input_dest
if [ -z "$input_dest" ]; then
  input_dest="$default_dest_raw"
fi

DEST_DIR="$(resolve_path "$input_dest" "$(pwd)")"

echo ""
echo "Install destination: $DEST_DIR"
if ! confirm_yes "Proceed with install?"; then
  echo "Install cancelled."
  exit 0
fi

mkdir -p "$DEST_DIR"
cp "$SRC_SKILL" "$DEST_DIR/SKILL.md"
sync_scripts_dir "$SRC_SCRIPTS" "$DEST_DIR/scripts"

chmod +x \
  "$DEST_DIR/scripts/install.sh" \
  "$DEST_DIR/scripts/run-agent" \
  "$DEST_DIR/scripts/monitor" \
  "$DEST_DIR/scripts/cleanup" \
  "$DEST_DIR/scripts/task-helper" \
  "$DEST_DIR/scripts/doctor"

if confirm_yes "Scaffold runtime files (.env, repos.json, logs/) if missing?"; then
  mkdir -p "$DEST_DIR/logs"

  if [ ! -f "$DEST_DIR/repos.json" ] && [ -f "$DEST_DIR/scripts/templates/repos.example.json" ]; then
    cp "$DEST_DIR/scripts/templates/repos.example.json" "$DEST_DIR/repos.json"
    echo "Created: $DEST_DIR/repos.json"
  fi

  if [ ! -f "$DEST_DIR/.env" ] && [ -f "$DEST_DIR/scripts/templates/.env.example" ]; then
    cp "$DEST_DIR/scripts/templates/.env.example" "$DEST_DIR/.env"
    echo "Created: $DEST_DIR/.env"
  fi
fi

echo ""
echo "Installed yetiswarm to: $DEST_DIR"
echo "Next steps:"
echo "  1) cd '$DEST_DIR'"
echo "  2) ./scripts/doctor --fix"
echo "  3) ./scripts/run-agent ..."

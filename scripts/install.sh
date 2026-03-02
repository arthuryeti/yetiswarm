#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT_DIR/skill/yetiswarm"
DEST_BASE="${OPENCLAW_SKILLS_DIR:-$HOME/.agents/skills}"
DEST_DIR="$DEST_BASE/yetiswarm"

if [[ ! -d "$SRC_DIR" ]]; then
  echo "Source skill directory not found: $SRC_DIR" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"

if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude '.DS_Store' \
    --exclude 'node_modules/' \
    --exclude 'dist/' \
    --exclude '__pycache__/' \
    --exclude '*.pyc' \
    --exclude 'logs/' \
    --exclude '*.db' \
    --exclude '*.db-*' \
    --exclude '.monitor.lock' \
    --exclude '.progress-state.json' \
    --exclude '.env' \
    --exclude 'repos.json' \
    "$SRC_DIR/" "$DEST_DIR/"
else
  echo "rsync is required but not found in PATH." >&2
  exit 1
fi

echo "Installed yetiswarm skill to: $DEST_DIR"
if [[ -n "${OPENCLAW_SKILLS_DIR:-}" ]]; then
  echo "Using OPENCLAW_SKILLS_DIR=$OPENCLAW_SKILLS_DIR"
else
  echo "Using default skills dir: $HOME/.agents/skills"
fi

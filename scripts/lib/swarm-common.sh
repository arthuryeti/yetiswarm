#!/usr/bin/env bash

if [ -n "${YETISWARM_COMMON_LOADED:-}" ]; then
  return 0
fi
YETISWARM_COMMON_LOADED=1

swarm_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
swarm_skill_root="$(cd "${swarm_script_dir}/.." && pwd)"

swarm_expand_home() {
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

swarm_resolve_path() {
  local input base expanded
  input="$1"
  base="$2"

  if [ -z "$input" ]; then
    printf '%s\n' ""
    return 0
  fi

  expanded="$(swarm_expand_home "$input")"
  case "$expanded" in
    /*)
      printf '%s\n' "$expanded"
      ;;
    *)
      printf '%s\n' "$base/$expanded"
      ;;
  esac
}

swarm_compute_paths() {
  local base home_input
  base="$(pwd)"

  if [ -n "${SWARM_HOME:-}" ]; then
    home_input="$SWARM_HOME"
  else
    home_input="$swarm_skill_root"
  fi

  SWARM_HOME="$(swarm_resolve_path "$home_input" "$base")"

  if [ -n "${SWARM_REPOS_FILE:-}" ]; then
    SWARM_REPOS_FILE="$(swarm_resolve_path "$SWARM_REPOS_FILE" "$SWARM_HOME")"
  else
    SWARM_REPOS_FILE="$SWARM_HOME/repos.json"
  fi

  if [ -n "${SWARM_DB_PATH:-}" ]; then
    SWARM_DB_PATH="$(swarm_resolve_path "$SWARM_DB_PATH" "$SWARM_HOME")"
  else
    SWARM_DB_PATH="$SWARM_HOME/swarm.db"
  fi

  if [ -n "${SWARM_LOGS_DIR:-}" ]; then
    SWARM_LOGS_DIR="$(swarm_resolve_path "$SWARM_LOGS_DIR" "$SWARM_HOME")"
  else
    SWARM_LOGS_DIR="$SWARM_HOME/logs"
  fi

  export SWARM_HOME
  export SWARM_REPOS_FILE
  export SWARM_DB_PATH
  export SWARM_LOGS_DIR
}

swarm_load_env() {
  local env_file
  env_file="$SWARM_HOME/.env"

  if [ -f "$env_file" ]; then
    # shellcheck disable=SC1090
    set -a
    . "$env_file"
    set +a
  fi
}

swarm_bootstrap() {
  if [ -n "${YETISWARM_BOOTSTRAPPED:-}" ]; then
    return 0
  fi

  swarm_compute_paths
  swarm_load_env
  swarm_compute_paths

  mkdir -p "$SWARM_HOME" "$SWARM_LOGS_DIR"
  YETISWARM_BOOTSTRAPPED=1
  export YETISWARM_BOOTSTRAPPED
}

swarm_run_runtime() {
  local entry
  entry="$1"
  shift

  swarm_bootstrap

  if ! command -v node >/dev/null 2>&1; then
    echo "Error: node is required but not found in PATH." >&2
    return 1
  fi

  if [ ! -f "$swarm_script_dir/runtime/${entry}.js" ]; then
    echo "Error: runtime entrypoint missing: $swarm_script_dir/runtime/${entry}.js" >&2
    return 1
  fi

  node "$swarm_script_dir/runtime/${entry}.js" "$@"
}

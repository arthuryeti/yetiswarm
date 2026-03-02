"""
runtime_paths.py — Resolve swarm runtime paths from env vars with compatibility fallback.
"""

from __future__ import annotations

import os


def _expand_home(path_value: str) -> str:
    if not path_value:
        return path_value
    return os.path.expanduser(path_value)


def _resolve_input_path(path_value: str, base_dir: str) -> str:
    expanded = _expand_home(path_value.strip())
    if not expanded:
        return expanded
    if os.path.isabs(expanded):
        return os.path.normpath(expanded)
    return os.path.abspath(os.path.join(base_dir, expanded))


def _has_swarm_markers(directory: str) -> bool:
    return any(
        os.path.exists(os.path.join(directory, marker))
        for marker in ("repos.json", "repos.example.json", "swarm.db")
    )


def _resolve_legacy_swarm_dir(entry_file: str) -> str:
    cwd = os.getcwd()
    if _has_swarm_markers(cwd):
        return cwd

    entry_dir = os.path.dirname(os.path.abspath(entry_file))
    if _has_swarm_markers(entry_dir):
        return entry_dir

    parent = os.path.dirname(entry_dir)
    if _has_swarm_markers(parent):
        return parent

    return entry_dir


def _resolve_default_swarm_home(entry_file: str) -> str:
    cwd = os.path.abspath(os.getcwd())
    if _has_swarm_markers(cwd):
        return cwd
    return _resolve_legacy_swarm_dir(entry_file)


def resolve_runtime_paths(entry_file: str) -> dict[str, str]:
    env_home = (os.environ.get("SWARM_HOME") or "").strip()
    env_repos = (os.environ.get("SWARM_REPOS_FILE") or "").strip()
    env_db = (os.environ.get("SWARM_DB_PATH") or "").strip()
    env_logs = (os.environ.get("SWARM_LOGS_DIR") or "").strip()

    swarm_home = (
        _resolve_input_path(env_home, os.getcwd())
        if env_home
        else _resolve_default_swarm_home(entry_file)
    )

    repos_file = _resolve_input_path(env_repos, swarm_home) if env_repos else os.path.join(swarm_home, "repos.json")
    db_path = _resolve_input_path(env_db, swarm_home) if env_db else os.path.join(swarm_home, "swarm.db")
    logs_dir = _resolve_input_path(env_logs, swarm_home) if env_logs else os.path.join(swarm_home, "logs")

    return {
        "swarm_home": swarm_home,
        "repos_file": repos_file,
        "db_path": db_path,
        "logs_dir": logs_dir,
    }

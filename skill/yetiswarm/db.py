"""
db.py — SQLite database layer for the agent swarm.

Provides:
  - get_connection() context manager (WAL mode, foreign keys, auto-commit/rollback)
  - init_db() to create tables
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager


# ── Connection helper ────────────────────────────────────────────────────────

@contextmanager
def get_connection(db_path: str):
    """Context manager: WAL mode, FK, busy timeout, auto-commit/rollback."""
    conn = sqlite3.connect(db_path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# ── Schema ───────────────────────────────────────────────────────────────────

_TASKS_TABLE = """
CREATE TABLE IF NOT EXISTS tasks (
    id                      TEXT PRIMARY KEY,
    repo_key                TEXT NOT NULL,
    repo_dir                TEXT NOT NULL,
    gh_repo                 TEXT NOT NULL,
    tmux_session            TEXT NOT NULL DEFAULT '',
    agent                   TEXT NOT NULL,
    model                   TEXT NOT NULL,
    thinking                TEXT NOT NULL,
    branch                  TEXT NOT NULL,
    worktree                TEXT NOT NULL DEFAULT '',
    started_at              INTEGER NOT NULL,
    status                  TEXT NOT NULL,
    retries                 INTEGER NOT NULL DEFAULT 0,
    pr                      INTEGER DEFAULT NULL,
    pr_url                  TEXT DEFAULT NULL,
    original_prompt         TEXT NOT NULL DEFAULT '',
    prompt                  TEXT NOT NULL DEFAULT '',
    notify_on_complete      INTEGER NOT NULL DEFAULT 1,
    checks                  TEXT NOT NULL DEFAULT '{}',
    completed_at            INTEGER DEFAULT NULL,
    comment_fix_retries     INTEGER NOT NULL DEFAULT 0,
    last_processed_comment_at TEXT NOT NULL DEFAULT '',
    pid                     INTEGER DEFAULT NULL,
    container_id            TEXT DEFAULT NULL
)
"""

_EVENTS_TABLE = """
CREATE TABLE IF NOT EXISTS task_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    old_status  TEXT DEFAULT NULL,
    new_status  TEXT DEFAULT NULL,
    detail      TEXT DEFAULT NULL,
    created_at  INTEGER NOT NULL
)
"""

_EVENTS_INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_events_task_id ON task_events(task_id)",
    "CREATE INDEX IF NOT EXISTS idx_events_created_at ON task_events(created_at)",
]


def init_db(db_path: str):
    """Create tables and indexes if they don't exist."""
    with get_connection(db_path) as conn:
        conn.execute(_TASKS_TABLE)
        conn.execute(_EVENTS_TABLE)
        for idx in _EVENTS_INDEXES:
            conn.execute(idx)

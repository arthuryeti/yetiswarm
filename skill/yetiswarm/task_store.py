"""
task_store.py — Importable module for agent swarm task management.

Provides:
  - Task dataclass (typed fields matching task schema)
  - TaskStore class (SQLite-backed CRUD for task registry)
  - Parsing functions for gh CLI output (no file I/O, pure transforms)
  - Repo config functions
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from dataclasses import dataclass, field, asdict
from typing import Optional

from db import get_connection, init_db


# ── Task dataclass ───────────────────────────────────────────────────────────

@dataclass
class Task:
    id: str
    repo_key: str
    repo_dir: str
    gh_repo: str
    tmux_session: str
    agent: str
    model: str
    thinking: str
    branch: str
    worktree: str
    started_at: int
    status: str
    retries: int = 0
    pr: Optional[int] = None
    pr_url: Optional[str] = None
    original_prompt: str = ""
    prompt: str = ""
    notify_on_complete: bool = True
    checks: dict = field(default_factory=dict)
    completed_at: Optional[int] = None
    comment_fix_retries: int = 0
    last_processed_comment_at: str = ""
    pid: Optional[int] = None
    container_id: Optional[str] = None

    # JSON key mapping: camelCase (JSON) <-> snake_case (Python)
    _KEY_MAP = {
        "id": "id",
        "repoKey": "repo_key",
        "repoDir": "repo_dir",
        "ghRepo": "gh_repo",
        "tmuxSession": "tmux_session",
        "agent": "agent",
        "model": "model",
        "thinking": "thinking",
        "branch": "branch",
        "worktree": "worktree",
        "startedAt": "started_at",
        "status": "status",
        "retries": "retries",
        "pr": "pr",
        "prUrl": "pr_url",
        "originalPrompt": "original_prompt",
        "prompt": "prompt",
        "notifyOnComplete": "notify_on_complete",
        "checks": "checks",
        "completedAt": "completed_at",
        "commentFixRetries": "comment_fix_retries",
        "lastProcessedCommentAt": "last_processed_comment_at",
        "pid": "pid",
        "containerId": "container_id",
    }

    _REVERSE_KEY_MAP = {v: k for k, v in _KEY_MAP.items()}

    @classmethod
    def from_dict(cls, d: dict) -> "Task":
        """Create Task from a camelCase JSON dict."""
        kwargs = {}
        for json_key, py_key in cls._KEY_MAP.items():
            if json_key in d:
                kwargs[py_key] = d[json_key]
        return cls(**kwargs)

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> "Task":
        """Create Task from a sqlite3.Row (snake_case columns)."""
        d = dict(row)
        # Deserialize checks from JSON string
        checks_raw = d.get("checks", "{}")
        if isinstance(checks_raw, str):
            d["checks"] = json.loads(checks_raw) if checks_raw else {}
        # Cast notify_on_complete from int to bool
        d["notify_on_complete"] = bool(d.get("notify_on_complete", 1))
        return cls(**{k: d[k] for k in d if k in cls.__dataclass_fields__})

    def to_dict(self) -> dict:
        """Serialize to camelCase JSON dict, matching legacy JSON schema."""
        result = {}
        for py_key, value in asdict(self).items():
            json_key = self._REVERSE_KEY_MAP.get(py_key, py_key)
            result[json_key] = value
        # Omit optional fields that are at their empty defaults
        _OPTIONAL_DEFAULTS = {
            "completedAt": None,
            "commentFixRetries": 0,
            "lastProcessedCommentAt": "",
            "pid": None,
            "containerId": None,
        }
        for key, default in _OPTIONAL_DEFAULTS.items():
            if key in result and result[key] == default:
                del result[key]
        return result


# ── Internal helpers ─────────────────────────────────────────────────────────

# All task columns in insertion order
_TASK_COLUMNS = [
    "id", "repo_key", "repo_dir", "gh_repo", "tmux_session", "agent", "model",
    "thinking", "branch", "worktree", "started_at", "status", "retries", "pr",
    "pr_url", "original_prompt", "prompt", "notify_on_complete", "checks",
    "completed_at", "comment_fix_retries", "last_processed_comment_at", "pid",
    "container_id",
]


def _task_to_row(task: Task) -> dict:
    """Convert a Task to a dict suitable for SQLite INSERT."""
    d = asdict(task)
    d["checks"] = json.dumps(d.get("checks", {}))
    d["notify_on_complete"] = 1 if d.get("notify_on_complete") else 0
    return d


def _log_event(conn, task_id: str, event_type: str, old_status: str = None, new_status: str = None, detail: str = None):
    """Insert into task_events."""
    conn.execute(
        "INSERT INTO task_events (task_id, event_type, old_status, new_status, detail, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (task_id, event_type, old_status, new_status, detail, int(time.time() * 1000)),
    )


# ── TaskStore (SQLite-backed CRUD) ──────────────────────────────────────────

class TaskStore:
    def __init__(self, db_path: str):
        # Backward compat: if caller passes a .json path, redirect to swarm.db
        if db_path.endswith(".json"):
            db_path = os.path.join(os.path.dirname(db_path) or ".", "swarm.db")
        self.db_path = db_path
        init_db(db_path)

    def load(self) -> list[Task]:
        """Load all tasks from the database."""
        with get_connection(self.db_path) as conn:
            rows = conn.execute("SELECT * FROM tasks").fetchall()
        return [Task.from_row(r) for r in rows]

    def save(self, tasks: list[Task]):
        """Replace all tasks in the database."""
        with get_connection(self.db_path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("DELETE FROM tasks")
            for t in tasks:
                row = _task_to_row(t)
                cols = ", ".join(_TASK_COLUMNS)
                placeholders = ", ".join("?" for _ in _TASK_COLUMNS)
                conn.execute(
                    f"INSERT INTO tasks ({cols}) VALUES ({placeholders})",
                    [row.get(c) for c in _TASK_COLUMNS],
                )

    def list_running(self) -> list[Task]:
        """Return tasks monitored by monitor.py."""
        with get_connection(self.db_path) as conn:
            rows = conn.execute(
                "SELECT * FROM tasks WHERE status IN ('running', 'done', 'needs-review')"
            ).fetchall()
        return [Task.from_row(r) for r in rows]

    def count_running(self) -> int:
        with get_connection(self.db_path) as conn:
            row = conn.execute(
                "SELECT COUNT(*) FROM tasks WHERE status IN ('running', 'done', 'needs-review')"
            ).fetchone()
        return row[0]

    def get_task(self, task_id: str) -> Optional[Task]:
        with get_connection(self.db_path) as conn:
            row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        return Task.from_row(row) if row else None

    def patch_task(self, task_id: str, patch: dict):
        """Merge a camelCase patch dict into a task. Merges 'checks' separately."""
        with get_connection(self.db_path) as conn:
            # Read current task
            row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
            if row is None:
                return

            old_status = row["status"]

            # Handle checks merge
            if "checks" in patch:
                existing_checks = json.loads(row["checks"] or "{}")
                existing_checks.update(patch.pop("checks"))
                patch["checks"] = json.dumps(existing_checks)

            # Map camelCase keys → snake_case columns
            updates = {}
            for camel_key, value in patch.items():
                snake_key = Task._KEY_MAP.get(camel_key, camel_key)
                if snake_key == "notify_on_complete":
                    value = 1 if value else 0
                elif snake_key == "checks" and isinstance(value, dict):
                    value = json.dumps(value)
                updates[snake_key] = value

            if not updates:
                return

            set_clause = ", ".join(f"{k} = ?" for k in updates)
            values = list(updates.values()) + [task_id]
            conn.execute(f"UPDATE tasks SET {set_clause} WHERE id = ?", values)

            # Log event on status change
            new_status = updates.get("status")
            if new_status and new_status != old_status:
                _log_event(conn, task_id, "status_change", old_status, new_status)

    def remove_task(self, task_id: str):
        with get_connection(self.db_path) as conn:
            row = conn.execute("SELECT status FROM tasks WHERE id = ?", (task_id,)).fetchone()
            conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
            if row:
                _log_event(conn, task_id, "removed", row["status"], None, "task removed")

    def register_task(self, task_json: str):
        """Add or update a task from a JSON string. Preserves fields on re-register."""
        task_data = json.loads(task_json)
        task_id = task_data["id"]

        with get_connection(self.db_path) as conn:
            existing = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()

            if existing:
                existing_d = dict(existing)
                # Always preserve these from the existing task (camelCase → snake_case)
                for camel, snake in [("retries", "retries"), ("pr", "pr"), ("prUrl", "pr_url")]:
                    if existing_d.get(snake) is not None:
                        task_data[camel] = existing_d[snake]

                # Preserve these only if the new task doesn't explicitly set them
                for camel, snake in [
                    ("originalPrompt", "original_prompt"),
                    ("commentFixRetries", "comment_fix_retries"),
                    ("lastProcessedCommentAt", "last_processed_comment_at"),
                ]:
                    if camel not in task_data and existing_d.get(snake):
                        task_data[camel] = existing_d[snake]

            # Convert camelCase task_data to snake_case row
            row = {}
            for camel_key, value in task_data.items():
                snake_key = Task._KEY_MAP.get(camel_key, camel_key)
                if snake_key == "checks":
                    value = json.dumps(value) if isinstance(value, dict) else value
                elif snake_key == "notify_on_complete":
                    value = 1 if value else 0
                row[snake_key] = value

            cols = ", ".join(row.keys())
            placeholders = ", ".join("?" for _ in row)
            conn.execute(
                f"INSERT OR REPLACE INTO tasks ({cols}) VALUES ({placeholders})",
                list(row.values()),
            )
            _log_event(conn, task_id, "registered", None, row.get("status"), "re-registered" if existing else "new task")

    def get_pr_url(self, task_id: str) -> str:
        with get_connection(self.db_path) as conn:
            row = conn.execute("SELECT pr_url FROM tasks WHERE id = ?", (task_id,)).fetchone()
        return (row["pr_url"] or "") if row else ""


# ── Parsing functions (no file I/O, just transform gh CLI output) ────────────

def parse_pr_data(json_str: str) -> tuple[Optional[int], Optional[str]]:
    """Parse gh pr list JSON -> (number, url) or (None, None).

    Selection priority:
      1) OPEN PRs
      2) MERGED PRs
      3) CLOSED PRs

    This avoids false "no PR" outcomes when a branch only has merged/closed PRs.
    """
    data = json.loads(json_str) if json_str else []
    if not data:
        return None, None

    def _state_rank(item: dict) -> int:
        state = (item.get("state") or "").upper()
        if state == "OPEN":
            return 0
        if state == "MERGED":
            return 1
        if item.get("mergedAt"):
            return 1
        if state == "CLOSED":
            return 2
        return 3

    best = min(data, key=_state_rank)
    return best.get("number"), best.get("url")


def parse_reviews(json_str: str) -> tuple[int, int, str]:
    """Parse review history -> (approved_count, changes_count, reviewers_str).

    Uses each reviewer's latest state (not historical totals), so old
    CHANGES_REQUESTED reviews that were later approved do not keep blocking.
    """
    data = json.loads(json_str) if json_str else []
    latest_by_reviewer: dict[str, tuple[str, str]] = {}

    for idx, review in enumerate(data):
        author = (review.get("author") or {}).get("login")
        if not author:
            author = f"unknown-{idx}"
        state = review.get("state", "")
        # `gh pr view --json reviews` uses submittedAt (camelCase),
        # while GH API responses use submitted_at (snake_case).
        submitted_at = review.get("submittedAt") or review.get("submitted_at") or ""
        # Keep latest by timestamp; if missing timestamp, later entries win.
        prev = latest_by_reviewer.get(author)
        if prev is None or submitted_at >= prev[0]:
            latest_by_reviewer[author] = (submitted_at, state)

    final_states = {author: state for author, (_, state) in latest_by_reviewer.items()}
    approved_reviewers = [a for a, s in final_states.items() if s == "APPROVED"]
    change_reviewers = [a for a, s in final_states.items() if s == "CHANGES_REQUESTED"]
    return len(approved_reviewers), len(change_reviewers), ", ".join(change_reviewers)


def parse_ci_status(json_str: str) -> str:
    """Parse gh pr checks JSON -> 'pass' | 'fail' | 'pending'.

    Empty checks (no CI configured on the repo) is treated as 'pass'
    so tasks aren't stuck forever waiting for CI that will never come.
    """
    checks = json.loads(json_str) if json_str else []
    if not checks:
        return "pass"
    if all(c.get("state") == "SUCCESS" for c in checks):
        return "pass"
    if any(c.get("state") in ("FAILURE", "ERROR", "CANCELLED") for c in checks):
        return "fail"
    return "pending"


def format_pr_feedback(
    reviews_json: str, comments_json: str, since: str = ""
) -> Optional[tuple[str, str]]:
    """Parse GitHub API feedback into agent-ready text.

    Returns (latest_timestamp, feedback_text) or None if no actionable feedback.
    """
    reviews = json.loads(reviews_json) if reviews_json else []
    comments = json.loads(comments_json) if comments_json else []

    # Find reviews with CHANGES_REQUESTED newer than `since`
    actionable_reviews = []
    for r in reviews:
        if r.get("state") != "CHANGES_REQUESTED":
            continue
        submitted_at = r.get("submitted_at", "")
        if since and submitted_at <= since:
            continue
        actionable_reviews.append(r)

    # Collect standalone inline comments newer than `since`
    actionable_review_ids = {r.get("id") for r in actionable_reviews}
    standalone_comments = []
    for c in comments:
        created_at = c.get("created_at", "")
        if since and created_at <= since:
            continue
        review_id = c.get("pull_request_review_id")
        if review_id not in actionable_review_ids:
            standalone_comments.append(c)

    if not actionable_reviews and not standalone_comments:
        return None

    # Track the latest timestamp
    timestamps = []
    for r in actionable_reviews:
        ts = r.get("submitted_at", "")
        if ts:
            timestamps.append(ts)
    for c in standalone_comments:
        ts = c.get("created_at", "")
        if ts:
            timestamps.append(ts)
    for c in comments:
        review_id = c.get("pull_request_review_id")
        if review_id in actionable_review_ids:
            ts = c.get("created_at", "")
            if ts:
                timestamps.append(ts)

    latest_at = max(timestamps) if timestamps else ""

    # Format the feedback
    lines = []

    for r in actionable_reviews:
        reviewer = r.get("user", {}).get("login", "reviewer")
        body = (r.get("body") or "").strip()
        review_id = r.get("id")

        lines.append(f"## Review by @{reviewer} (Changes Requested)")
        if body:
            lines.append(body)
        lines.append("")

        # Attach inline comments that belong to this review
        review_comments = [
            c for c in comments if c.get("pull_request_review_id") == review_id
        ]
        for c in review_comments:
            path = c.get("path", "")
            line_num = c.get("line") or c.get("original_line") or ""
            comment_body = (c.get("body") or "").strip()
            if comment_body:
                loc = f"{path}:{line_num}" if line_num else path
                lines.append(f"### {loc}")
                lines.append(comment_body)
                lines.append("")

    # Standalone inline comments
    if standalone_comments:
        lines.append("## Additional Inline Comments")
        lines.append("")
        for c in standalone_comments:
            path = c.get("path", "")
            line_num = c.get("line") or c.get("original_line") or ""
            comment_body = (c.get("body") or "").strip()
            user = c.get("user", {}).get("login", "reviewer")
            if comment_body:
                loc = f"{path}:{line_num}" if line_num else path
                lines.append(f"### {loc} (@{user})")
                lines.append(comment_body)
                lines.append("")

    if not lines:
        return None

    return latest_at, "\n".join(lines)


# ── Repo config functions ────────────────────────────────────────────────────

def load_repo_config(repos_file: str, repo_key: str) -> Optional[dict]:
    """Load a single repo's config from repos.json. Returns None if not found."""
    with open(repos_file) as f:
        repos = json.load(f)
    r = repos.get("repos", {}).get(repo_key)
    if not r:
        return None
    return {
        "path": r.get("path", ""),
        "ghRepo": r.get("ghRepo", ""),
        "worktrees": r.get("worktrees", ""),
        "ciCmd": r.get("ciCmd", "npm run build"),
        "installCmd": r.get("installCmd", "npm install --silent"),
        "dockerCompose": r.get("dockerCompose", False),
        "promptPreamble": r.get("promptPreamble", ""),
    }


def list_repo_keys(repos_file: str) -> list[str]:
    """List all repo keys from repos.json."""
    with open(repos_file) as f:
        repos = json.load(f)
    return list(repos.get("repos", {}).keys())

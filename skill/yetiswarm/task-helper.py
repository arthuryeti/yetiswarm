#!/usr/bin/env python3
"""
task-helper.py — CLI wrapper for agent swarm task management.

Thin adapter: parses CLI args and delegates to task_store module.
Keeps exact same interface for run-agent.sh and cleanup.sh.

Usage:
  task-helper.py list-running <tasks-file>
  task-helper.py count-running <tasks-file>
  task-helper.py get-field <json-string> <field> [--default <val>]
  task-helper.py get-fields <json-string> <field1> <field2> ...
  task-helper.py parse-pr <json-string>
  task-helper.py parse-reviews <json-string>
  task-helper.py parse-ci <json-string>
  task-helper.py patch-task <tasks-file> <task-id> <patch-json>
  task-helper.py remove-task <tasks-file> <task-id>
  task-helper.py get-pr-url <tasks-file> <task-id>
  task-helper.py register-task <tasks-file> <task-json>
  task-helper.py repo-config <repos-file> <repo-key>
  task-helper.py repo-keys <repos-file>
  task-helper.py format-pr-feedback <reviews-api-json> <comments-api-json> [--since <iso-ts>]
"""

from __future__ import annotations

import json
import sys

from task_store import (
    TaskStore,
    parse_pr_data,
    parse_reviews,
    parse_ci_status,
    format_pr_feedback,
    load_repo_config,
    list_repo_keys,
)
from db import get_connection
from runtime_paths import resolve_runtime_paths


def _runtime_defaults():
    runtime = resolve_runtime_paths(__file__)
    return runtime["db_path"], runtime["repos_file"]


def _consume_db_path(args):
    default_db_path, _ = _runtime_defaults()
    if not args:
        return default_db_path, []
    return args[0], args[1:]


def _consume_repos_file(args):
    _, default_repos_file = _runtime_defaults()
    if not args:
        return default_repos_file, []
    return args[0], args[1:]


def cmd_list_running(args):
    db_path, _ = _consume_db_path(args)
    store = TaskStore(db_path)
    for t in store.list_running():
        print(json.dumps(t.to_dict()))


def cmd_count_running(args):
    db_path, _ = _consume_db_path(args)
    store = TaskStore(db_path)
    print(store.count_running())


def cmd_get_field(args):
    obj = json.loads(args[0])
    field = args[1]
    default = args[3] if len(args) > 3 and args[2] == "--default" else ""
    val = obj.get(field)
    print(val if val is not None else default)


def cmd_get_fields(args):
    """Print multiple fields separated by record separator (\\x1e) on one line."""
    obj = json.loads(args[0])
    fields = args[1:]
    vals = []
    for f in fields:
        v = obj.get(f)
        vals.append(str(v) if v is not None else "")
    print("\x1e".join(vals))


def cmd_parse_pr(args):
    number, url = parse_pr_data(args[0] if args[0] else "")
    if number is not None:
        print(f"{number}\t{url}")
    else:
        print("\t")


def cmd_parse_reviews(args):
    approved, changes, reviewers = parse_reviews(args[0] if args[0] else "")
    print(f"{approved}\t{changes}\t{reviewers}")


def cmd_parse_ci(args):
    print(parse_ci_status(args[0] if args[0] else ""))


def cmd_patch_task(args):
    db_path, rest = _consume_db_path(args)
    store = TaskStore(db_path)
    store.patch_task(rest[0], json.loads(rest[1]))


def cmd_remove_task(args):
    db_path, rest = _consume_db_path(args)
    store = TaskStore(db_path)
    store.remove_task(rest[0])


def cmd_get_pr_url(args):
    db_path, rest = _consume_db_path(args)
    store = TaskStore(db_path)
    print(store.get_pr_url(rest[0]))


def cmd_register_task(args):
    db_path, rest = _consume_db_path(args)
    store = TaskStore(db_path)
    store.register_task(rest[0])


def cmd_repo_config(args):
    repos_file, rest = _consume_repos_file(args)
    config = load_repo_config(repos_file, rest[0])
    if not config:
        sys.exit(1)
    print(f"{config['path']}\t{config['ghRepo']}\t{config['worktrees']}\t{config['ciCmd']}\t{config['installCmd']}")


def cmd_repo_keys(args):
    repos_file, _ = _consume_repos_file(args)
    print(", ".join(list_repo_keys(repos_file)))


def cmd_format_pr_feedback(args):
    reviews_json = args[0] if args[0] else ""
    comments_json = args[1] if args[1] else ""
    since = ""
    if len(args) > 3 and args[2] == "--since":
        since = args[3]

    result = format_pr_feedback(reviews_json, comments_json, since=since)
    if result is not None:
        latest_at, feedback_text = result
        print(latest_at)
        print(feedback_text)


def cmd_dump_tasks(args):
    """Export all tasks as camelCase JSON (matches old active-tasks.json format)."""
    db_path, _ = _consume_db_path(args)
    store = TaskStore(db_path)
    tasks = store.load()
    print(json.dumps({"tasks": [t.to_dict() for t in tasks]}, indent=2))


def cmd_dump_events(args):
    """Export recent task events as JSON."""
    db_path, rest = _consume_db_path(args)
    limit = int(rest[0]) if len(rest) > 0 else 50
    with get_connection(db_path) as conn:
        rows = conn.execute(
            "SELECT * FROM task_events ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
    events = [dict(r) for r in rows]
    print(json.dumps(events, indent=2))


COMMANDS = {
    "list-running": cmd_list_running,
    "count-running": cmd_count_running,
    "get-field": cmd_get_field,
    "get-fields": cmd_get_fields,
    "parse-pr": cmd_parse_pr,
    "parse-reviews": cmd_parse_reviews,
    "parse-ci": cmd_parse_ci,
    "patch-task": cmd_patch_task,
    "remove-task": cmd_remove_task,
    "get-pr-url": cmd_get_pr_url,
    "register-task": cmd_register_task,
    "repo-config": cmd_repo_config,
    "repo-keys": cmd_repo_keys,
    "format-pr-feedback": cmd_format_pr_feedback,
    "dump-tasks": cmd_dump_tasks,
    "dump-events": cmd_dump_events,
}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print(f"Usage: {sys.argv[0]} <command> [args...]", file=sys.stderr)
        print(f"Commands: {', '.join(COMMANDS.keys())}", file=sys.stderr)
        sys.exit(1)
    COMMANDS[sys.argv[1]](sys.argv[2:])

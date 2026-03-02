#!/usr/bin/env python3
"""
cleanup.py — Remove worktrees and registry entries for done/failed tasks.

Replaces cleanup.sh. Importable module + CLI wrapper.
Run daily or manually after merging PRs.

Usage:
  python3 cleanup.py
"""

from __future__ import annotations

import json
import os
import sys

from shell import (
    _run,
    setup_cron_env,
    kill_agent,
    git_worktree_remove,
    git_worktree_prune,
    git_branch_delete,
)
from task_store import TaskStore, load_repo_config, list_repo_keys
from runtime_paths import resolve_runtime_paths


def _gh_pr_state(gh_bin: str, gh_repo: str, pr_number: int) -> str:
    """Return PR state ('OPEN', 'MERGED', 'CLOSED') or empty string on failure."""
    if not gh_repo or not pr_number:
        return ""

    result = _run([
        gh_bin, "pr", "view", str(pr_number),
        "--repo", gh_repo, "--json", "state", "-q", ".state"
    ])
    return result.stdout.strip() if result.returncode == 0 else ""


def _branch_has_merged_pr(gh_bin: str, gh_repo: str, branch: str) -> bool:
    """True if the branch has at least one merged PR on GitHub."""
    if not gh_repo or not branch:
        return False

    result = _run([
        gh_bin, "pr", "list",
        "--repo", gh_repo,
        "--head", branch,
        "--state", "all",
        "--json", "state,mergedAt",
        "--limit", "20",
    ])
    if result.returncode != 0:
        return False

    try:
        data = json.loads(result.stdout or "[]")
    except json.JSONDecodeError:
        return False

    return any((pr.get("state") == "MERGED") or pr.get("mergedAt") for pr in data)


def _list_local_branches(repo_dir: str) -> list[str]:
    result = _run([
        "/usr/bin/git", "-C", repo_dir,
        "for-each-ref", "--format=%(refname:short)", "refs/heads"
    ])
    if result.returncode != 0:
        return []
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def _current_branch(repo_dir: str) -> str:
    result = _run(["/usr/bin/git", "-C", repo_dir, "branch", "--show-current"])
    if result.returncode != 0:
        return ""
    return result.stdout.strip()


def cleanup(db_path: str | None = None, repos_file: str | None = None) -> int:
    """Clean up finished (done/failed) tasks.

    Kills agent processes/sessions, removes worktrees, prunes stale refs,
    and removes done/failed entries from the task registry.

    Returns the number of tasks cleaned.
    """
    runtime = resolve_runtime_paths(__file__)

    if db_path is None:
        db_path = runtime["db_path"]
    if repos_file is None:
        repos_file = runtime["repos_file"]

    gh_bin = "/opt/homebrew/bin/gh" if os.path.isfile("/opt/homebrew/bin/gh") else "gh"
    store = TaskStore(db_path)
    tasks = store.load()

    cleaned = 0
    cleaned_ids: set[str] = set()

    finished = [t for t in tasks if t.status in ("done", "failed")]

    if finished:
        print("Cleaning up finished tasks...")
        for task in finished:
            pr_state = ""
            if task.pr and task.gh_repo:
                pr_state = _gh_pr_state(gh_bin, task.gh_repo, task.pr)

            # Guardrail: only clean "done" tasks with a PR after the PR is merged.
            if task.status == "done" and task.pr and pr_state != "MERGED":
                state_label = pr_state or "unknown"
                print(f"  Skipping {task.id}: PR #{task.pr} is {state_label} (not merged)")
                continue

            # Kill agent (PID or tmux fallback)
            kill_agent(task)
            print(f"  Killed agent: {task.id}")

            # Remove worktree — use task.worktree directly (bug fix vs bash version
            # which reconstructed path from hardcoded WORKTREES_DIR)
            if task.worktree and os.path.isdir(task.worktree) and task.repo_dir:
                removed = git_worktree_remove(task.repo_dir, task.worktree)
                if removed:
                    print(f"  Removed worktree: {task.worktree}")
                else:
                    print(f"  Failed to remove worktree: {task.worktree}")

            # Delete local feature branch once its PR is merged.
            if task.repo_dir and task.branch and pr_state == "MERGED":
                deleted = git_branch_delete(task.repo_dir, task.branch, force=True)
                if deleted:
                    print(f"  Deleted branch: {task.branch}")

            cleaned += 1
            cleaned_ids.add(task.id)
    else:
        print("No finished tasks in registry.")

    # Prune stale refs in each repo
    print("Pruning stale worktree refs...")
    for key in list_repo_keys(repos_file):
        config = load_repo_config(repos_file, key)
        if config:
            git_worktree_prune(config["path"])

    # Sweep merged leftovers (older tasks already removed from registry).
    print("Sweeping merged local branches/worktrees...")
    protected = {"main", "master", "develop", "dev"}
    active_worktrees = {t.worktree for t in tasks if t.worktree}
    merged_swept = 0

    for key in list_repo_keys(repos_file):
        config = load_repo_config(repos_file, key)
        if not config:
            continue

        repo_dir = config["path"]
        gh_repo = config["ghRepo"]
        worktrees_root = config.get("worktrees", "")

        merged_cache: dict[str, bool] = {}

        def is_merged_branch(branch: str) -> bool:
            if branch not in merged_cache:
                merged_cache[branch] = _branch_has_merged_pr(gh_bin, gh_repo, branch)
            return merged_cache[branch]

        if worktrees_root and os.path.isdir(worktrees_root):
            for entry in os.listdir(worktrees_root):
                worktree_path = os.path.join(worktrees_root, entry)
                if not os.path.isdir(worktree_path):
                    continue
                if worktree_path in active_worktrees:
                    continue

                branch = _current_branch(worktree_path)
                if not branch or branch in protected:
                    continue

                if is_merged_branch(branch):
                    removed = git_worktree_remove(repo_dir, worktree_path)
                    if removed:
                        print(f"  Removed merged orphan worktree: {worktree_path}")
                        merged_swept += 1
                    deleted = git_branch_delete(repo_dir, branch, force=True)
                    if deleted:
                        print(f"  Deleted merged orphan branch: {branch}")

        for branch in _list_local_branches(repo_dir):
            if branch in protected:
                continue
            if is_merged_branch(branch):
                deleted = git_branch_delete(repo_dir, branch, force=True)
                if deleted:
                    print(f"  Deleted merged local branch: {branch}")
                    merged_swept += 1

    # Keep tasks that were not explicitly cleaned above.
    remaining = [t for t in tasks if t.id not in cleaned_ids]
    store.save(remaining)

    print(f"Cleaned {cleaned} task(s); swept {merged_swept} merged leftover artifact(s).")
    return cleaned + merged_swept


def main():
    setup_cron_env()
    cleanup()


if __name__ == "__main__":
    main()

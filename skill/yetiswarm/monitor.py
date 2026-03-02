#!/usr/bin/env python3
"""
monitor.py — Agent swarm monitor (replaces check-agents.sh).

Runs every 10 min via cron. Checks all running/done tasks, manages PR lifecycle,
respawns failed agents, notifies via Telegram.

State machine with explicit states per task:
  AWAITING_MERGE     — status="done", has PR, waiting for GitHub merge
  CHECK_AGENT        — entry point: is agent alive? idle timeout?
  AGENT_DEAD_NO_PR   — agent dead, no PR -> respawn or fail
  DETECT_PR          — search GitHub for PR on branch
  CHECK_MERGE        — has PR, check if merged -> cleanup
  CHECK_CI           — check gh pr checks -> respawn on failure
  CHECK_REVIEWS      — CI passing, check for CHANGES_REQUESTED
  ALL_GREEN          — CI pass + no changes requested -> mark done
"""

from __future__ import annotations

import logging
import os
import sys
import time
import fcntl
from dataclasses import dataclass
from enum import Enum, auto

from shell import (
    _run,
    setup_cron_env,
    is_agent_alive,
    kill_agent,
    git_worktree_remove,
    git_branch_delete,
)
from run_agent import spawn_agent
from task_store import Task, TaskStore, parse_pr_data, parse_reviews, parse_ci_status, format_pr_feedback
from runtime_paths import resolve_runtime_paths


# ── State enum ───────────────────────────────────────────────────────────────

class TaskState(Enum):
    AWAITING_MERGE = auto()
    CHECK_AGENT = auto()
    AGENT_DEAD_NO_PR = auto()
    DETECT_PR = auto()
    CHECK_MERGE = auto()
    CHECK_CI = auto()
    CHECK_REVIEWS = auto()
    ALL_GREEN = auto()


# ── Monitor context ──────────────────────────────────────────────────────────

@dataclass
class MonitorContext:
    swarm_dir: str
    repos_file: str
    db_path: str
    logs_dir: str
    store: TaskStore
    max_retries: int = 3
    max_comment_retries: int = 3
    idle_timeout_secs: int = 1800  # 30 minutes
    notify_channel: str = "discord"
    notify_target: str = ""
    gh_bin: str = "/opt/homebrew/bin/gh"


# ── External command wrappers ────────────────────────────────────────────────
# All return parsed results, never raise on failure (match current `|| true`)

def gh_pr_view(ctx: MonitorContext, pr_number: int, gh_repo: str) -> str:
    """Get PR state ('OPEN', 'MERGED', 'CLOSED') or empty string on failure."""
    result = _run([
        ctx.gh_bin, "pr", "view", str(pr_number),
        "--repo", gh_repo, "--json", "state", "-q", ".state"
    ])
    return result.stdout.strip() if result.returncode == 0 else ""


def gh_pr_list(ctx: MonitorContext, gh_repo: str, branch: str) -> str:
    """Search for PR by head branch. Returns raw JSON string."""
    result = _run([
        ctx.gh_bin, "pr", "list", "--repo", gh_repo,
        "--head", branch, "--state", "all",
        "--json", "number,url,state,mergedAt,closedAt", "--limit", "20"
    ])
    return result.stdout.strip() if result.returncode == 0 else "[]"


def gh_pr_checks(ctx: MonitorContext, pr_number: int, gh_repo: str) -> str:
    """Get CI check results as JSON string."""
    result = _run([
        ctx.gh_bin, "pr", "checks", str(pr_number),
        "--repo", gh_repo, "--json", "name,state"
    ])
    return result.stdout.strip() if result.returncode == 0 else "[]"


def gh_pr_reviews(ctx: MonitorContext, pr_number: int, gh_repo: str) -> str:
    """Get PR reviews as JSON string."""
    result = _run([
        ctx.gh_bin, "pr", "view", str(pr_number),
        "--repo", gh_repo, "--json", "reviews", "-q", ".reviews"
    ])
    return result.stdout.strip() if result.returncode == 0 else "[]"


def gh_api(ctx: MonitorContext, endpoint: str) -> str:
    """Call gh api, return raw JSON string."""
    result = _run([ctx.gh_bin, "api", endpoint])
    return result.stdout.strip() if result.returncode == 0 else "[]"


def notify_telegram(ctx: MonitorContext, message: str):
    if not ctx.notify_target:
        return
    _run([
        "openclaw", "message", "send",
        "--channel", ctx.notify_channel,
        "--target", ctx.notify_target,
        "--message", message,
    ])


def is_session_idle(ctx: MonitorContext, task_id: str) -> bool:
    """Check if an agent's log file hasn't been written to recently."""
    log_file = os.path.join(ctx.logs_dir, f"{task_id}.log")
    if not os.path.isfile(log_file):
        return False  # No log file = can't determine, assume not idle

    try:
        last_modified = os.path.getmtime(log_file)
        age = time.time() - last_modified
        return age > ctx.idle_timeout_secs
    except OSError:
        return False


# ── Respawn functions ────────────────────────────────────────────────────────

def respawn_task(
    ctx: MonitorContext, task: Task, error_context: str = ""
):
    """Kill agent, increment retries, respawn with clean prompt."""
    new_retries = task.retries + 1
    ctx.store.patch_task(task.id, {"retries": new_retries, "status": "running"})

    kill_agent(task)

    # Build clean retry prompt: original + short error addendum
    retry_prompt = task.original_prompt
    if error_context:
        retry_prompt = (
            f"{task.original_prompt}\n\n"
            f"IMPORTANT \u2014 This is retry attempt {new_retries}/{ctx.max_retries}. "
            f"Previous attempt failed:\n{error_context}\n"
            f"Fix these issues, then push and update the existing PR (do NOT create a new one)."
        )

    log.info("  Respawning %s (attempt %d/%d)", task.id, new_retries, ctx.max_retries)
    spawn_agent(
        repo_key=task.repo_key,
        task_id=task.id,
        branch=task.branch,
        agent=task.agent,
        model=task.model,
        thinking=task.thinking,
        prompt=retry_prompt,
        swarm_dir=ctx.swarm_dir,
        repos_file=ctx.repos_file,
        db_path=ctx.db_path,
        logs_dir=ctx.logs_dir,
    )


def respawn_for_review(
    ctx: MonitorContext, task: Task,
    comment_retries: int, feedback_text: str
):
    """Respawn specifically for review feedback (separate retry counter)."""
    new_comment_retries = comment_retries + 1

    kill_agent(task)

    fix_prompt = (
        f"{task.original_prompt}\n\n"
        f"IMPORTANT \u2014 A reviewer has left feedback on your PR. "
        f"This is review-fix attempt {new_comment_retries}/{ctx.max_comment_retries}.\n\n"
        f"Address ALL of the following review comments:\n{feedback_text}\n\n"
        f"After fixing:\n"
        f"1. Commit with a message like: fix: address PR review feedback\n"
        f"2. Push to the same branch (do NOT create a new PR)\n"
        f"3. Make sure the build still passes"
    )

    log.info("  Respawning %s for review fixes (attempt %d/%d)",
             task.id, new_comment_retries, ctx.max_comment_retries)
    spawn_agent(
        repo_key=task.repo_key,
        task_id=task.id,
        branch=task.branch,
        agent=task.agent,
        model=task.model,
        thinking=task.thinking,
        prompt=fix_prompt,
        swarm_dir=ctx.swarm_dir,
        repos_file=ctx.repos_file,
        db_path=ctx.db_path,
        logs_dir=ctx.logs_dir,
    )


# ── State determination ──────────────────────────────────────────────────────

def determine_state(task: Task) -> TaskState:
    """Determine initial state from task data."""
    has_pr = task.pr is not None and str(task.pr) != "None"

    if task.status in ("done", "needs-review") and has_pr:
        return TaskState.AWAITING_MERGE

    return TaskState.CHECK_AGENT


# ── State handlers ───────────────────────────────────────────────────────────
# Each returns next state or None to stop processing this task.

def handle_awaiting_merge(task: Task, ctx: MonitorContext) -> TaskState | None:
    """Status="done", has PR — just check if merged for cleanup."""
    pr_state = gh_pr_view(ctx, task.pr, task.gh_repo)

    if pr_state == "MERGED":
        log.info("  PR #%s merged — cleaning up", task.pr)
        kill_agent(task)
        if task.worktree and os.path.isdir(task.worktree) and task.repo_dir:
            removed = git_worktree_remove(task.repo_dir, task.worktree)
            if not removed:
                log.warning("  Failed to remove worktree: %s", task.worktree)
        if task.repo_dir and task.branch:
            deleted = git_branch_delete(task.repo_dir, task.branch, force=True)
            if not deleted:
                log.info("  Local branch not deleted (already absent/in use): %s", task.branch)
        ctx.store.remove_task(task.id)
        return None

    log.info("  PR #%s not yet merged (state: %s)", task.pr, pr_state or "unknown")
    return None


def handle_check_agent(task: Task, ctx: MonitorContext) -> TaskState | None:
    """Check if agent process is alive + idle timeout detection."""
    agent_alive = is_agent_alive(task)
    has_pr = task.pr is not None and str(task.pr) != "None"

    # Idle timeout detection
    if agent_alive and task.status == "running":
        if is_session_idle(ctx, task.id):
            idle_min = ctx.idle_timeout_secs // 60
            log.info("  Agent alive but idle for >%dmin — treating as hung", idle_min)
            kill_agent(task)
            agent_alive = False

    if not has_pr:
        # Always attempt PR detection first, even if agent is dead.
        # This prevents false respawns when the agent already opened a PR.
        return TaskState.DETECT_PR

    return TaskState.CHECK_MERGE


def handle_agent_dead_no_pr(task: Task, ctx: MonitorContext) -> TaskState | None:
    """Agent dead, no PR — respawn or fail."""
    if task.retries < ctx.max_retries:
        log.info("  Session dead, no PR — respawning")
        notify_telegram(ctx,
            f"\u26a0\ufe0f `{task.id}` died before creating a PR. "
            f"Respawning (attempt {task.retries + 1}/{ctx.max_retries})...")
        respawn_task(ctx, task, "Agent process died before creating a PR.")
    else:
        ctx.store.patch_task(task.id, {"status": "failed"})
        notify_telegram(ctx,
            f"\u274c `{task.id}` ({task.repo_key}) failed after {ctx.max_retries} attempts. "
            f"Needs your attention.")
    return None


def handle_detect_pr(task: Task, ctx: MonitorContext) -> TaskState | None:
    """Search GitHub for PR on branch."""
    pr_data = gh_pr_list(ctx, task.gh_repo, task.branch)
    pr_number, pr_url = parse_pr_data(pr_data)

    if pr_number is not None:
        log.info("  PR #%s found", pr_number)
        ctx.store.patch_task(task.id, {"pr": pr_number, "prUrl": pr_url})
        # Update local task object for subsequent handlers
        task.pr = pr_number
        task.pr_url = pr_url
        return TaskState.CHECK_MERGE

    agent_alive = is_agent_alive(task)
    log.info("  Still working (agent alive: %s)", agent_alive)
    if not agent_alive:
        return TaskState.AGENT_DEAD_NO_PR
    return None


def handle_check_merge(task: Task, ctx: MonitorContext) -> TaskState | None:
    """Has PR — check if merged, then cleanup."""
    # Refresh pr_url from store in case it was just updated
    pr_url = ctx.store.get_pr_url(task.id) or task.pr_url or ""
    task.pr_url = pr_url

    pr_state = gh_pr_view(ctx, task.pr, task.gh_repo)

    if pr_state == "MERGED":
        log.info("  PR #%s merged — cleaning up", task.pr)
        kill_agent(task)
        if task.worktree and os.path.isdir(task.worktree) and task.repo_dir:
            removed = git_worktree_remove(task.repo_dir, task.worktree)
            if not removed:
                log.warning("  Failed to remove worktree: %s", task.worktree)
        if task.repo_dir and task.branch:
            deleted = git_branch_delete(task.repo_dir, task.branch, force=True)
            if not deleted:
                log.info("  Local branch not deleted (already absent/in use): %s", task.branch)
        ctx.store.remove_task(task.id)
        return None

    return TaskState.CHECK_CI


def handle_check_ci(task: Task, ctx: MonitorContext) -> TaskState | None:
    """Check CI status — respawn on failure, wait on pending."""
    ci_json = gh_pr_checks(ctx, task.pr, task.gh_repo)
    ci_status = parse_ci_status(ci_json)
    pr_url = task.pr_url or ""

    if ci_status == "fail":
        if task.retries < ctx.max_retries:
            notify_telegram(ctx,
                f"\U0001f501 `{task.id}` CI failed — auto-fixing "
                f"(attempt {task.retries + 1}/{ctx.max_retries})...")
            respawn_task(ctx, task, "CI checks failed. Check build output and fix errors.")
        else:
            ctx.store.patch_task(task.id, {"status": "failed"})
            notify_telegram(ctx,
                f"\u274c `{task.id}` CI still failing after {ctx.max_retries} attempts.\n"
                f"PR: {pr_url}")
        return None

    if ci_status in ("pending", "unknown"):
        log.info("  CI pending...")
        return None

    return TaskState.CHECK_REVIEWS


def handle_check_reviews(task: Task, ctx: MonitorContext) -> TaskState | None:
    """CI passing — check for CHANGES_REQUESTED reviews."""
    reviews_json = gh_pr_reviews(ctx, task.pr, task.gh_repo)
    approved, changes, reviewers = parse_reviews(reviews_json)
    pr_url = task.pr_url or ""

    if changes > 0:
        # Don't try to fix while agent is still working
        if is_agent_alive(task):
            log.info("  Changes requested but agent still working — waiting...")
            return None

        # Load comment_fix_retries from raw JSON (may not be on Task object from initial load)
        raw_task = ctx.store.get_task(task.id)
        comment_retries = raw_task.comment_fix_retries if raw_task else 0

        if comment_retries < ctx.max_comment_retries:
            # Fetch detailed review feedback via GitHub API
            reviews_api = gh_api(ctx, f"repos/{task.gh_repo}/pulls/{task.pr}/reviews")
            comments_api = gh_api(ctx, f"repos/{task.gh_repo}/pulls/{task.pr}/comments")
            last_processed = raw_task.last_processed_comment_at if raw_task else ""

            feedback = format_pr_feedback(reviews_api, comments_api, since=last_processed)

            if feedback is not None:
                latest_at, comment_text = feedback
                new_comment_retries = comment_retries + 1
                ctx.store.patch_task(task.id, {
                    "commentFixRetries": new_comment_retries,
                    "lastProcessedCommentAt": latest_at,
                    "status": "running",
                })

                notify_telegram(ctx,
                    f"\U0001f527 `{task.id}` — auto-fixing review feedback from {reviewers} "
                    f"(attempt {new_comment_retries}/{ctx.max_comment_retries})...\n"
                    f"PR: {pr_url}")

                respawn_for_review(ctx, task, comment_retries, comment_text)
            else:
                # Changes requested but no parseable comments
                ctx.store.patch_task(task.id, {"status": "needs-review"})
                notify_telegram(ctx,
                    f"\U0001f534 `{task.id}` — changes requested by {reviewers} "
                    f"(no inline comments found).\nPR: {pr_url}")
        else:
            # Exhausted comment-fix retries
            ctx.store.patch_task(task.id, {"status": "needs-review"})
            notify_telegram(ctx,
                f"\U0001f534 `{task.id}` — review fixes failed after "
                f"{ctx.max_comment_retries} attempts. Needs manual attention.\n"
                f"Reviewers: {reviewers}\nPR: {pr_url}")
        return None

    # Store approved count for ALL_GREEN handler
    task._approved = approved
    return TaskState.ALL_GREEN


def handle_all_green(task: Task, ctx: MonitorContext) -> TaskState | None:
    """CI pass + no changes requested — mark done, notify."""
    completed_at = int(time.time() * 1000)
    ctx.store.patch_task(task.id, {"status": "done", "completedAt": completed_at})

    pr_url = task.pr_url or ""
    approved = getattr(task, "_approved", 0)

    log.info("  Done! PR #%s ready", task.pr)
    notify_telegram(ctx,
        f"\u2705 PR #{task.pr} ready to merge\n"
        f"\U0001f33f `{task.id}` \u00b7 `{task.repo_key}`\n"
        f"\U0001f517 {pr_url}\n"
        f"CI passing \u00b7 {approved} review(s)")
    return None


# ── State dispatch ───────────────────────────────────────────────────────────

HANDLERS = {
    TaskState.AWAITING_MERGE: handle_awaiting_merge,
    TaskState.CHECK_AGENT: handle_check_agent,
    TaskState.AGENT_DEAD_NO_PR: handle_agent_dead_no_pr,
    TaskState.DETECT_PR: handle_detect_pr,
    TaskState.CHECK_MERGE: handle_check_merge,
    TaskState.CHECK_CI: handle_check_ci,
    TaskState.CHECK_REVIEWS: handle_check_reviews,
    TaskState.ALL_GREEN: handle_all_green,
}


def process_task(task: Task, ctx: MonitorContext):
    """Run state machine for a single task."""
    state = determine_state(task)

    while state is not None:
        handler = HANDLERS[state]
        state = handler(task, ctx)


# ── Logging setup ────────────────────────────────────────────────────────────

def setup_logging(logs_dir: str) -> logging.Logger:
    logger = logging.getLogger("monitor")
    logger.setLevel(logging.INFO)

    formatter = logging.Formatter("%(message)s")

    # stdout handler
    stdout_handler = logging.StreamHandler(sys.stdout)
    stdout_handler.setFormatter(formatter)
    logger.addHandler(stdout_handler)

    # File handler
    log_file = os.path.join(logs_dir, "monitor.log")
    os.makedirs(logs_dir, exist_ok=True)
    file_handler = logging.FileHandler(log_file, mode="a")
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)

    return logger


def acquire_monitor_lock(swarm_dir: str):
    """Acquire a non-blocking singleton lock for monitor runs."""
    lock_path = os.path.join(swarm_dir, ".monitor.lock")
    lock_fh = open(lock_path, "w")
    try:
        fcntl.flock(lock_fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock_fh.close()
        return None
    return lock_fh


# Module-level logger (set up in main)
log = logging.getLogger("monitor")


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    global log

    setup_cron_env()
    runtime = resolve_runtime_paths(__file__)
    swarm_dir = runtime["swarm_home"]
    repos_file = runtime["repos_file"]
    db_path = runtime["db_path"]
    logs_dir = runtime["logs_dir"]

    log = setup_logging(logs_dir)
    lock_fh = acquire_monitor_lock(swarm_dir)
    if lock_fh is None:
        now = time.strftime("%H:%M")
        log.info("%s Monitor already running — skipping overlap.", now)
        return

    try:
        store = TaskStore(db_path)
        ctx = MonitorContext(
            swarm_dir=swarm_dir,
            repos_file=repos_file,
            db_path=db_path,
            logs_dir=logs_dir,
            store=store,
            notify_channel=(os.environ.get("SWARM_NOTIFY_CHANNEL") or "discord"),
            notify_target=(os.environ.get("SWARM_NOTIFY_TARGET") or ""),
        )

        running_count = store.count_running()
        now = time.strftime("%H:%M")

        if running_count == 0:
            log.info("%s No running tasks.", now)
            return

        log.info("%s Checking %d agent(s)...", now, running_count)

        tasks = store.list_running()
        for task in tasks:
            # Ensure original_prompt fallback
            if not task.original_prompt:
                task.original_prompt = task.prompt

            log.info("  -> [%s/%s] checking...", task.repo_key, task.id)

            try:
                process_task(task, ctx)
            except Exception:
                log.exception("  ERROR processing %s:", task.id)
                # Per-task try/except: one broken task doesn't block others

        log.info("%s Check complete.", now)
    finally:
        try:
            fcntl.flock(lock_fh.fileno(), fcntl.LOCK_UN)
        finally:
            lock_fh.close()


if __name__ == "__main__":
    main()

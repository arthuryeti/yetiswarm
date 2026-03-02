#!/usr/bin/env python3
"""
run_agent.py — Spawn a coding agent as a background process with its own worktree.

Importable module + CLI wrapper.

Usage:
  python3 run_agent.py <repo-key> <task-id> <branch> <agent> <model> <thinking> "<prompt>"
"""

from __future__ import annotations

import json
import os
import sys
import time

from shell import (
    _run,
    setup_cron_env,
    process_spawn,
    process_is_alive,
    is_agent_alive,
    git_fetch,
    git_pull,
    git_branch_exists,
    git_worktree_add_existing,
    git_worktree_add_new,
    docker_compose_up,
    run_install,
)
from task_store import TaskStore, parse_pr_data, load_repo_config, list_repo_keys
from runtime_paths import resolve_runtime_paths


# ── Private helpers ──────────────────────────────────────────────────────────

def _cmd_output(result) -> str:
    msg = (result.stderr or result.stdout or "").strip()
    return msg or "No command output."


def _find_branch_worktree(repo_dir: str, branch: str) -> str | None:
    """Return existing worktree path currently checked out on `branch`, if any."""
    result = _run(["/usr/bin/git", "-C", repo_dir, "worktree", "list", "--porcelain"], timeout=30)
    if result.returncode != 0:
        return None

    current_path = None
    expected_ref = f"refs/heads/{branch}"
    for raw_line in result.stdout.splitlines():
        line = raw_line.strip()
        if line.startswith("worktree "):
            current_path = line[len("worktree "):].strip()
            continue
        if line.startswith("branch "):
            ref = line[len("branch "):].strip()
            if ref in (expected_ref, branch):
                return current_path
    return None


def _setup_worktree(repo_dir: str, worktrees_dir: str, worktree_path: str, branch: str) -> str:
    """Create or update worktree for the task. Returns resolved worktree path."""
    os.makedirs(worktrees_dir, exist_ok=True)
    fetch_result = git_fetch(repo_dir)
    if fetch_result.returncode != 0:
        raise RuntimeError(
            f"git fetch failed for repo '{repo_dir}'.\n{_cmd_output(fetch_result)}"
        )

    if os.path.isdir(worktree_path):
        print(f"Worktree exists at {worktree_path} — pulling latest")
        pull_result = git_pull(worktree_path, branch)
        if pull_result.returncode != 0:
            print(f"Warning: git pull failed in existing worktree ({branch}). Continuing.\n{_cmd_output(pull_result)}")
    elif git_branch_exists(repo_dir, branch):
        print(f"Creating worktree from existing branch: {branch}")
        add_result = git_worktree_add_existing(repo_dir, worktree_path, branch)
        if not os.path.isdir(worktree_path):
            # Common case: branch is already checked out in another worktree.
            existing_path = _find_branch_worktree(repo_dir, branch)
            if existing_path and os.path.isdir(existing_path):
                print(
                    f"Branch '{branch}' is already checked out at {existing_path} "
                    "— reusing that worktree."
                )
                worktree_path = existing_path
            else:
                raise RuntimeError(
                    f"git worktree add failed for existing branch '{branch}'.\n{_cmd_output(add_result)}"
                )

        pull_result = git_pull(worktree_path, branch)
        if pull_result.returncode != 0:
            print(f"Warning: git pull failed in worktree ({branch}). Continuing.\n{_cmd_output(pull_result)}")
    else:
        print(f"Creating worktree with new branch: {branch}")
        add_result = git_worktree_add_new(repo_dir, worktree_path, branch)
        if add_result.returncode != 0 or not os.path.isdir(worktree_path):
            raise RuntimeError(
                f"git worktree add failed for new branch '{branch}'.\n{_cmd_output(add_result)}"
            )

    if not os.path.isdir(worktree_path):
        raise RuntimeError(
            f"Resolved worktree path does not exist: {worktree_path}"
        )
    return worktree_path


def _copy_env(repo_dir: str, worktree_path: str):
    """Copy .env from main repo if missing in worktree."""
    if not os.path.isdir(worktree_path):
        raise RuntimeError(
            f"Worktree path does not exist: {worktree_path}. "
            "Agent setup cannot continue."
        )
    src = os.path.join(repo_dir, ".env")
    dst = os.path.join(worktree_path, ".env")
    if os.path.isfile(src) and not os.path.isfile(dst):
        import shutil
        shutil.copy2(src, dst)
        print("Copied .env")


def _tail_file(path: str, max_lines: int = 25) -> str:
    if not os.path.isfile(path):
        return "Log file not found."
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except OSError:
        return "Unable to read log file."
    tail = "".join(lines[-max_lines:]).strip()
    return tail or "No log output captured."


def _find_existing_pr(gh_repo: str, branch: str) -> tuple[int | None, str | None]:
    """Find existing OPEN PR by branch head."""
    result = _run([
        "gh", "pr", "list",
        "--repo", gh_repo,
        "--head", branch,
        "--json", "number,url,state",
        "--limit", "1",
    ])
    if result.returncode != 0:
        return None, None
    return parse_pr_data(result.stdout.strip())


# ── Main function ────────────────────────────────────────────────────────────

def spawn_agent(
    repo_key: str,
    task_id: str,
    branch: str,
    agent: str,
    model: str,
    thinking: str,
    prompt: str,
    *,
    swarm_dir: str | None = None,
    repos_file: str | None = None,
    db_path: str | None = None,
    logs_dir: str | None = None,
):
    """Spawn a coding agent as a background process with its own worktree.

    Args:
        repo_key: Key in repos.json (e.g. "engine")
        task_id: Unique task identifier
        branch: Git branch name
        agent: Agent type (e.g. "codex", "claude")
        model: Model name (e.g. "gpt-5.3-codex")
        thinking: Reasoning effort ("low", "medium", "high")
        prompt: User prompt for the agent
        swarm_dir: Override swarm home (defaults to SWARM_HOME or current working directory)
    """
    runtime = resolve_runtime_paths(__file__)
    if swarm_dir is None:
        swarm_dir = runtime["swarm_home"]
    if repos_file is None:
        repos_file = runtime["repos_file"]
    if db_path is None:
        db_path = runtime["db_path"]
    if logs_dir is None:
        logs_dir = runtime["logs_dir"]

    # ── Resolve repo config ──────────────────────────────────────────────
    config = load_repo_config(repos_file, repo_key)
    if config is None:
        print(f"Unknown repo key: {repo_key}. Check repos.json.")
        sys.exit(1)

    repo_dir = config["path"]
    gh_repo = config["ghRepo"]
    worktrees_dir = config["worktrees"]
    ci_cmd = config["ciCmd"]
    install_cmd = config["installCmd"]
    docker_compose = config.get("dockerCompose", False)
    prompt_preamble = config.get("promptPreamble", "")

    worktree_path = os.path.join(worktrees_dir, task_id)
    log_file = os.path.join(logs_dir, f"{task_id}.log")

    # ── Check for existing agent ────────────────────────────────────────
    store = TaskStore(db_path)
    existing = store.get_task(task_id)
    if existing and is_agent_alive(existing):
        print(f"Agent '{task_id}' is already running (PID {existing.pid}). Kill it first.")
        sys.exit(1)

    # Guardrail: avoid concurrent agents writing to the same branch.
    for task in store.list_running():
        if (
            task.id != task_id
            and task.repo_key == repo_key
            and task.branch == branch
            and is_agent_alive(task)
        ):
            print(
                f"Branch '{branch}' already has an active agent task '{task.id}' "
                f"(PID {task.pid}). Stop or reuse that task first."
            )
            sys.exit(1)

    # ── Build full prompt ────────────────────────────────────────────────
    pr_instructions = (
        f"\n\nWhen the implementation is complete:\n"
        f"1. Run: {ci_cmd}\n"
        f"2. Fix any errors before proceeding\n"
        f"3. Commit all changes with a clear commit message\n"
        f"4. Push the branch: git push origin {branch}\n"
        f"5. Open a PR: gh pr create --fill --repo {gh_repo}\n"
        f"6. PR description must include: what changed, why, and screenshots if any UI changed"
    )

    if prompt_preamble:
        pr_instructions = f"\n{prompt_preamble}{pr_instructions}"

    full_prompt = f"{prompt}{pr_instructions}"

    # ── Resolve existing PR by branch (if any) ───────────────────────────
    existing_pr, existing_pr_url = _find_existing_pr(gh_repo, branch)
    if existing_pr is not None:
        print(f"Found existing PR #{existing_pr} for branch {branch}")

    # ── Register task early ──────────────────────────────────────────────
    # Register before setup so the task is visible even if spawn fails.
    # Monitor can detect it as dead and respawn.
    started_at = int(time.time() * 1000)
    task_json = json.dumps({
        "id": task_id,
        "repoKey": repo_key,
        "repoDir": repo_dir,
        "ghRepo": gh_repo,
        "tmuxSession": "",
        "agent": agent,
        "model": model,
        "thinking": thinking,
        "branch": branch,
        "worktree": worktree_path,
        "startedAt": started_at,
        "status": "running",
        "retries": 0,
        "pr": existing_pr,
        "prUrl": existing_pr_url,
        "originalPrompt": prompt,
        "prompt": full_prompt,
        "notifyOnComplete": True,
        "checks": {},
        "pid": None,
    })

    store.register_task(task_json)

    try:
        # ── Create worktree ──────────────────────────────────────────────
        resolved_worktree = _setup_worktree(repo_dir, worktrees_dir, worktree_path, branch)
        if resolved_worktree != worktree_path:
            worktree_path = resolved_worktree
            store.patch_task(task_id, {"worktree": worktree_path})

        # ── Copy .env ────────────────────────────────────────────────────
        _copy_env(repo_dir, worktree_path)

        # ── Install deps ─────────────────────────────────────────────────
        print("Installing dependencies...")
        install_result = run_install(worktree_path, install_cmd)
        if install_result.returncode != 0:
            install_err = (install_result.stderr or install_result.stdout or "").strip()
            if len(install_err) > 1200:
                install_err = install_err[-1200:]
            raise RuntimeError(
                f"Dependency install failed (exit {install_result.returncode}) for '{install_cmd}'.\n"
                f"{install_err or 'No command output available.'}"
            )

        # ── Repo hooks: docker compose ───────────────────────────────────
        if docker_compose:
            print("Ensuring Docker DB is up...")
            docker_compose_up(repo_dir)

        # ── Write prompt to file ─────────────────────────────────────────
        prompt_file = os.path.join(worktree_path, ".agent-prompt.txt")
        with open(prompt_file, "w") as f:
            f.write(full_prompt)

        # ── Spawn agent process ──────────────────────────────────────────
        agent_cmd = (
            f'codex exec --model "{model}" '
            f'-c "model_reasoning_effort={thinking}" '
            f'--dangerously-bypass-approvals-and-sandbox - < "{prompt_file}"'
        )

        os.makedirs(logs_dir, exist_ok=True)
        print(f"Spawning {agent} agent as background process...")
        pid = process_spawn(agent_cmd, cwd=worktree_path, log_file=log_file)

        # ── Update task with PID ─────────────────────────────────────────
        store.patch_task(task_id, {"pid": pid})

        # Detect immediate startup failures (missing binary, invalid flags, etc).
        time.sleep(1.0)
        if not process_is_alive(pid):
            raise RuntimeError(
                "Agent process exited immediately after spawn.\n"
                f"Last log output:\n{_tail_file(log_file)}"
            )
    except Exception as exc:
        store.patch_task(task_id, {"checks": {"spawnError": str(exc)}, "pid": None})
        raise

    # ── Summary ──────────────────────────────────────────────────────────
    print()
    print("Agent launched")
    print(f"   Repo     : {repo_key} ({gh_repo})")
    print(f"   Task ID  : {task_id}")
    print(f"   Branch   : {branch}")
    print(f"   Agent    : {agent} ({model} · thinking: {thinking})")
    print(f"   Worktree : {worktree_path}")
    print(f"   PID      : {pid}")
    print(f"   Log      : {log_file}")
    print(f"   Watch    : tail -f {log_file}")


# ── CLI wrapper ──────────────────────────────────────────────────────────────

def main():
    setup_cron_env()
    runtime = resolve_runtime_paths(__file__)

    if len(sys.argv) < 8:
        repos_file = runtime["repos_file"]
        keys = ", ".join(list_repo_keys(repos_file)) if os.path.isfile(repos_file) else "?"
        print(f'Usage: {sys.argv[0]} <repo-key> <task-id> <branch> <agent> <model> <thinking> "<prompt>"')
        print(f"Repos: {keys}")
        sys.exit(1)

    spawn_agent(
        repo_key=sys.argv[1],
        task_id=sys.argv[2],
        branch=sys.argv[3],
        agent=sys.argv[4],
        model=sys.argv[5],
        thinking=sys.argv[6],
        prompt=sys.argv[7],
        swarm_dir=runtime["swarm_home"],
        repos_file=runtime["repos_file"],
        db_path=runtime["db_path"],
        logs_dir=runtime["logs_dir"],
    )


if __name__ == "__main__":
    main()

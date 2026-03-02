"""
shell.py — Shared subprocess helpers for the agent swarm.

Provides wrappers for process management, tmux, git, docker, and environment setup.
No swarm-internal imports (no task_store, no monitor).
"""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import time


# ── Core runner ──────────────────────────────────────────────────────────────

def _run(
    cmd: list[str], timeout: int = 30, cwd: str | None = None
) -> subprocess.CompletedProcess:
    """Run a command, return CompletedProcess. Never raises."""
    try:
        return subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="")


# ── Environment setup ────────────────────────────────────────────────────────

def setup_cron_env():
    """Set PATH and load GH_TOKEN for cron environment."""
    home = os.path.expanduser("~")
    existing_parts = [p for p in os.environ.get("PATH", "").split(os.pathsep) if p]

    # Include common install locations for tools used by monitor/run_agent.
    preferred_parts = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        os.path.join(home, ".local", "bin"),
    ]

    pnpm_dir = os.path.join(home, "Library", "pnpm")
    preferred_parts.append(pnpm_dir)
    pnpm_nodejs_root = os.path.join(pnpm_dir, "nodejs")
    if os.path.isdir(pnpm_nodejs_root):
        for entry in sorted(os.listdir(pnpm_nodejs_root), reverse=True):
            candidate = os.path.join(pnpm_nodejs_root, entry, "bin")
            if os.path.isdir(candidate):
                preferred_parts.append(candidate)

    merged = []
    for path_part in preferred_parts + existing_parts:
        if path_part and path_part not in merged:
            merged.append(path_part)

    os.environ["PATH"] = os.pathsep.join(merged)

    gh_token_file = os.path.expanduser("~/.config/gh/gh_token.txt")
    if os.path.isfile(gh_token_file):
        with open(gh_token_file) as f:
            os.environ["GH_TOKEN"] = f.read().strip()


# ── tmux wrappers ────────────────────────────────────────────────────────────

def tmux_has_session(session: str) -> bool:
    result = _run(["tmux", "has-session", "-t", session])
    return result.returncode == 0


def tmux_kill_session(session: str):
    _run(["tmux", "kill-session", "-t", session])


def tmux_new_session(session: str, cwd: str):
    _run(["tmux", "new-session", "-d", "-s", session, "-c", cwd])


def tmux_pipe_pane(session: str, log_file: str):
    _run(["tmux", "pipe-pane", "-t", session, f"cat >> '{log_file}'"])


def tmux_send_keys(session: str, cmd: str):
    _run(["tmux", "send-keys", "-t", session, cmd, "Enter"])


# ── git wrappers ─────────────────────────────────────────────────────────────

def git_fetch(repo_dir: str):
    return _run(["/usr/bin/git", "-C", repo_dir, "fetch", "origin"], timeout=60)


def git_pull(cwd: str, branch: str):
    """Pull from origin. Never raises (matches `|| true` in bash)."""
    return _run(["/usr/bin/git", "pull", "origin", branch], cwd=cwd)


def git_branch_exists(repo_dir: str, branch: str) -> bool:
    """Check if branch exists locally or on remote."""
    result = _run([
        "/usr/bin/git", "-C", repo_dir,
        "branch", "-a", "--list", branch, f"origin/{branch}",
    ])
    return bool(result.stdout.strip())


def git_worktree_add_existing(repo_dir: str, path: str, branch: str):
    """Add a worktree for an existing branch."""
    return _run(["/usr/bin/git", "-C", repo_dir, "worktree", "add", path, branch])


def git_worktree_add_new(
    repo_dir: str, path: str, branch: str, base: str = "origin/main"
):
    """Add a worktree with a new branch based on `base`."""
    return _run(["/usr/bin/git", "-C", repo_dir, "worktree", "add", path, "-b", branch, base])


def git_worktree_remove(repo_dir: str, worktree: str):
    """Remove a worktree.

    If git removal fails and `trash`/`trash-put` is available, move it to trash.
    """
    result = _run(["/usr/bin/git", "-C", repo_dir, "worktree", "remove", "--force", worktree])
    if result.returncode == 0:
        return True

    if os.path.isdir(worktree):
        trash_bin = shutil.which("trash") or shutil.which("trash-put")
        if trash_bin:
            trash_result = _run([trash_bin, worktree])
            if trash_result.returncode == 0:
                return True

    return False


def git_worktree_prune(repo_dir: str):
    _run(["/usr/bin/git", "-C", repo_dir, "worktree", "prune"])


def git_branch_delete(repo_dir: str, branch: str, force: bool = False) -> bool:
    """Delete a local branch. Returns True on success.

    Protected branches are never deleted.
    """
    if not branch:
        return False

    if branch.startswith("refs/heads/"):
        branch = branch[len("refs/heads/"):]

    if branch in {"main", "master", "develop", "dev"}:
        return False

    flag = "-D" if force else "-d"
    result = _run(["/usr/bin/git", "-C", repo_dir, "branch", flag, branch])
    return result.returncode == 0


# ── Other helpers ────────────────────────────────────────────────────────────

def docker_compose_up(cwd: str):
    """Start docker compose services in detached mode."""
    _run(["docker", "compose", "up", "-d"], cwd=cwd, timeout=60)


def run_install(cwd: str, install_cmd: str):
    """Run an install command (e.g. 'npm install --silent').

    Uses shell=True because install_cmd is a string from operator-controlled repos.json.
    """
    try:
        return subprocess.run(
            install_cmd, shell=True, cwd=cwd,
            capture_output=True, text=True, timeout=120,
        )
    except subprocess.TimeoutExpired as exc:
        return subprocess.CompletedProcess(
            install_cmd,
            124,
            stdout=exc.stdout or "",
            stderr=(exc.stderr or "") + "\nInstall command timed out after 120s.",
        )
    except OSError as exc:
        return subprocess.CompletedProcess(
            install_cmd, 1, stdout="", stderr=str(exc)
        )


# ── Process management ───────────────────────────────────────────────────────

def process_spawn(cmd: str, cwd: str, log_file: str, env: dict | None = None) -> int:
    """Spawn a command as a background process, return its PID.

    stdout/stderr go to log_file. start_new_session=True gives the same
    isolation as a tmux session (own process group, survives parent exit).
    """
    merged_env = {**os.environ, **(env or {})}
    log_fd = open(log_file, "a")
    proc = subprocess.Popen(
        cmd, shell=True, cwd=cwd,
        stdout=log_fd, stderr=subprocess.STDOUT,
        start_new_session=True, env=merged_env,
    )
    return proc.pid


def process_is_alive(pid: int) -> bool:
    """Check if a process is still running (signal 0 = existence check)."""
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError, OSError):
        return False


def process_kill(pid: int, timeout: int = 10):
    """SIGTERM → poll → SIGKILL if still alive after timeout."""
    try:
        os.kill(pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError, OSError):
        return

    deadline = time.time() + timeout
    while time.time() < deadline:
        if not process_is_alive(pid):
            return
        time.sleep(0.5)

    # Still alive — force kill
    try:
        os.kill(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        pass


def is_agent_alive(task) -> bool:
    """Check if an agent is alive. Checks PID first, falls back to tmux for old tasks.

    task: any object with .pid and .tmux_session attributes.
    """
    if task.pid and task.pid > 0:
        return process_is_alive(task.pid)
    if task.tmux_session:
        return tmux_has_session(task.tmux_session)
    return False


def kill_agent(task):
    """Kill an agent. Handles both PID-tracked and tmux-based agents.

    task: any object with .pid and .tmux_session attributes.
    """
    if task.pid and task.pid > 0:
        process_kill(task.pid)
    if task.tmux_session:
        tmux_kill_session(task.tmux_session)

# YetiSwarm

Portable packaging for the YetiSwarm skill and TypeScript runtime.

## What YetiSwarm Is

YetiSwarm is an orchestration layer for coding-agent tasks across configured repos. It spawns one agent per task in an isolated git worktree, tracks task state in SQLite, and drives follow-up automation from PR/CI/review signals.

## What Problems It Solves

- Removes manual orchestration across multiple repos and branches.
- Prevents “lost state” between agent retries, CI failures, and review rounds.
- Standardizes cleanup of merged worktrees, branches, and stale task records.

## Core Capabilities

- Spawn agents with `npm run run-agent -- ...` (task, branch, prompt, model).
- Monitor PR/CI/review state with `npm run monitor`.
- Auto-respawn fix loops for CI failures and review feedback.
- Cleanup completed/merged work with `npm run cleanup`.
- Inspect task and event history with `npm run task-helper -- ...`.

## End-to-End Task Lifecycle

1. `run-agent` creates/reuses a worktree, prepares env/deps, and starts the agent.
2. Agent pushes commits and opens/updates a PR.
3. `monitor` checks process health, CI checks, PR state, and review status.
4. If CI fails or agent hangs/exits, monitor respawns with targeted fix context.
5. If reviewers request changes, monitor fetches review feedback and respawns a review-fix pass.
6. When CI/reviews are good, task moves to done/ready.
7. After merge, cleanup removes worktree/branch artifacts and task registry leftovers.

## Shareable Skill Code vs Local Runtime State

Shareable (commit/distribute):

- `skill/yetiswarm/` TypeScript runtime source, built entrypoints, templates, docs.
- `scripts/install.sh` installer.
- `runtime/example-state/` example structure only.

Local runtime state (never commit):

- `repos.json`
- `.env`
- `swarm.db` and `swarm.db-*`
- `logs/`
- `.monitor.lock`
- `.progress-state.json`

## Quick Practical Examples

Install skill package:

```bash
./scripts/install.sh
```

Initialize local runtime config:

```bash
cd "${OPENCLAW_SKILLS_DIR:-$HOME/.agents/skills}/yetiswarm"
cp repos.example.json repos.json
cp .env.example .env
npm install
npm run build
```

Spawn a task (TypeScript runtime entrypoint):

```bash
npm run run-agent -- engine fix-login-timeout fix/login-timeout codex gpt-5.3-codex high "Fix login timeout handling and update tests."
```

Monitor/fix loop and cleanup:

```bash
npm run monitor
npm run cleanup
npm run task-helper -- dump-tasks
```

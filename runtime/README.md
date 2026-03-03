# YetiSwarm

YetiSwarm is a TypeScript-only runtime for orchestrating coding-agent work across repos.

## What YetiSwarm Is

It runs task orchestration around coding agents: spawn an agent in a dedicated worktree, track task state in `swarm.db`, then drive CI/review handling and cleanup automatically.

## What Problems It Solves

- Keeps agent work isolated per task/branch.
- Automates repetitive PR follow-up (CI failures and requested changes).
- Preserves durable task state/events instead of ad-hoc shell tracking.
- Prevents long-lived stale worktrees/branches after merge.

## Core Capabilities

- `run-agent`: create/reuse worktree, register task, launch agent process.
- `monitor`: poll task/PR/CI/review state and trigger respawn/fix loops.
- `cleanup`: remove finished task artifacts and merged leftovers.
- `task-helper`: inspect and parse task/event/PR helper data.

## End-to-End Lifecycle of a Task

1. `run-agent` starts a task and writes task metadata to `swarm.db`.
2. Agent commits/pushes and creates or updates a PR.
3. `monitor` checks liveness, CI state, review state, and merge status.
4. CI fail or dead/hung process triggers respawn with focused fix context.
5. `CHANGES_REQUESTED` triggers review-feedback formatting and respawn.
6. Passing CI + acceptable review state marks task ready/done.
7. Merge triggers cleanup of worktree/branch and task records/events.

## Shareable Skill Code vs Local Runtime State

Shareable (commit these):

- `src/` and `dist/` runtime code.
- `package.json`, `tsconfig.json`, docs, and templates (`*.example`).

Local runtime state (do not commit):

- `repos.json`
- `.env`
- `swarm.db` and `swarm.db-*`
- `logs/`
- `.monitor.lock`
- `.progress-state.json`

## Setup (TypeScript Runtime)

```bash
npm install
npm run build
cp repos.example.json repos.json
cp .env.example .env
```

Edit `repos.json` with real repo/worktree paths.

## Runtime Environment Variables

All entrypoints support:

- `SWARM_HOME`
- `SWARM_REPOS_FILE`
- `SWARM_DB_PATH`
- `SWARM_LOGS_DIR`

Example:

```bash
export SWARM_HOME="$HOME/.openclaw/workspace/swarm"
export SWARM_REPOS_FILE="$SWARM_HOME/repos.json"
export SWARM_DB_PATH="$SWARM_HOME/swarm.db"
export SWARM_LOGS_DIR="$SWARM_HOME/logs"
```

If unset, runtime uses legacy auto-discovery.

## Quick Practical Examples

Spawn one agent task:

```bash
npm run run-agent -- engine feat-billing-invoice feat/billing-invoice codex gpt-5.3-codex high "Implement invoice export API and tests."
```

Run monitor loop once (for cron/scheduler use):

```bash
npm run monitor
```

Inspect tasks/events:

```bash
npm run task-helper -- dump-tasks
npm run task-helper -- dump-events 20
```

Cleanup merged/finished artifacts:

```bash
npm run cleanup
```

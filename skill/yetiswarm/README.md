# YetiSwarm

YetiSwarm orchestrates coding-agent tasks across configured repositories.

## Portable Runtime Model

The skill package is shareable; runtime state is local:

- Shareable: scripts, TypeScript/Python source, docs, templates.
- Local runtime: `repos.json`, `swarm.db`, `logs/`, monitor lock/progress files, `.env`.

## Setup

```bash
npm install
npm run build
cp repos.example.json repos.json
cp .env.example .env
```

Edit `repos.json` with your local repository/worktree paths.

## Runtime Env Vars

All entrypoints (`run-agent`, `monitor`, `cleanup`, `task-helper`) support:

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

Defaults and compatibility:

- If not set, the runtime auto-discovers legacy locations (CWD marker detection, then entrypoint-relative fallback).
- Relative values are resolved from `SWARM_HOME` (or discovered runtime home).

## Commands

```bash
npm run run-agent -- <repo-key> <task-id> <branch> <agent> <model> <thinking> "<prompt>"
npm run monitor
npm run cleanup
npm run task-helper -- dump-tasks
```

## Runtime Files (Local Only)

- `repos.json`
- `swarm.db` and `swarm.db-*`
- `logs/`
- `.monitor.lock`
- `.progress-state.json`
- `.env`

These are intentionally gitignored.

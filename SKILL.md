---
name: yetiswarm
description: Orchestrate coding-agent tasks across configured repositories with helper scripts for spawning agents, monitoring CI/review loops, cleanup, and task inspection.
---

# yetiswarm

Orchestrate coding agents for configured repositories.

## Install

From this repo:

```bash
./scripts/install.sh
```

Install target defaults to `~/.agents/skills/yetiswarm`, or `${OPENCLAW_SKILLS_DIR}/yetiswarm` when set.

## Flat Runtime Interface

After install, the skill package is intentionally flat:

- `SKILL.md`
- `scripts/install.sh`
- `scripts/run-agent`
- `scripts/monitor`
- `scripts/cleanup`
- `scripts/task-helper`
- `scripts/doctor`
- `scripts/runtime/*.js` (runtime engine)
- `scripts/templates/*` (scaffold files)

This repository also includes `skill/yetiswarm/` only as a legacy build shim. Canonical skill docs are at repo-root `SKILL.md`.

## Runtime Configuration

These env vars are supported:

- `SWARM_HOME`
- `SWARM_REPOS_FILE`
- `SWARM_DB_PATH`
- `SWARM_LOGS_DIR`

If omitted, helper scripts default `SWARM_HOME` to the skill directory and derive the others from it.

## Local-Only Runtime State

Keep these files local (not committed):

- `repos.json`
- `.env`
- `swarm.db` and `swarm.db-*`
- `logs/`
- `.monitor.lock`
- `.progress-state.json`

## Recommended First Run

```bash
./scripts/doctor --fix
```

Then set real repo paths in `repos.json` and spawn tasks with:

```bash
./scripts/run-agent <repo-key> <task-id> <branch> <agent> <model> <thinking> "<prompt>"
```

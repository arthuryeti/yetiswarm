# YetiSwarm

Portable packaging for the YetiSwarm skill and swarm runtime helpers.

## What YetiSwarm Is

YetiSwarm orchestrates coding-agent tasks across configured repos. It spawns one agent per task in an isolated git worktree, tracks task state in SQLite, and automates follow-up from PR/CI/review signals.

## Quick Install (Interactive)

```bash
./scripts/install.sh
```

The installer is interactive and supports:

- default install path (`~/.agents/skills/yetiswarm`)
- `OPENCLAW_SKILLS_DIR` override
- `~` path expansion
- confirmation prompts
- idempotent re-installs

After install:

```bash
cd "${OPENCLAW_SKILLS_DIR:-$HOME/.agents/skills}/yetiswarm"
./scripts/doctor --fix
```

## Installed Skill Layout (Flat)

The installed skill intentionally uses a flat package layout:

- `SKILL.md`
- `scripts/install.sh`
- `scripts/run-agent`
- `scripts/monitor`
- `scripts/cleanup`
- `scripts/task-helper`
- `scripts/doctor`
- `scripts/runtime/*.js`
- `scripts/templates/*`

## Runtime Commands

```bash
./scripts/run-agent engine fix-login-timeout fix/login-timeout codex gpt-5.3-codex high "Fix login timeout handling and update tests."
./scripts/monitor
./scripts/cleanup
./scripts/task-helper dump-tasks
```

## Runtime State

Local runtime state is not shareable and should not be committed:

- `repos.json`
- `.env`
- `swarm.db` and `swarm.db-*`
- `logs/`
- `.monitor.lock`
- `.progress-state.json`

## Repo Layout

This repository keeps:

- `SKILL.md` as the canonical skill instructions
- `scripts/` for installer + executable runtime helpers + templates
- `runtime/src/` for TypeScript runtime source used for maintenance
- `runtime/example-state/` as layout documentation
- `skill/yetiswarm/` as a minimal backward-compatibility shim for legacy `npm --prefix skill/yetiswarm ...` commands

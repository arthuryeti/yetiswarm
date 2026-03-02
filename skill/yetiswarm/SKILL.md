# yetiswarm

Orchestrate coding agents for configured repositories.

## Runtime Configuration

This skill reads runtime paths from these environment variables:

- `SWARM_HOME`
- `SWARM_REPOS_FILE`
- `SWARM_DB_PATH`
- `SWARM_LOGS_DIR`

If omitted, entrypoints keep legacy behavior by auto-discovering runtime locations.

## Local-Only Runtime State

Keep these files local (not committed):

- `repos.json`
- `swarm.db` and `swarm.db-*`
- `logs/`
- `.monitor.lock`
- `.progress-state.json`
- `.env`

Create local config from templates:

```bash
cp repos.example.json repos.json
cp .env.example .env
```

## Build

This runtime is TypeScript-only and compiles to `dist/*.js`.

```bash
npm install
npm run build
```

## Install Skill Package

From repo root:

```bash
./scripts/install.sh
```

Install target defaults to `~/.agents/skills/yetiswarm`, or `${OPENCLAW_SKILLS_DIR}/yetiswarm` when set.

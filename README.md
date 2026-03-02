# yetiswarm

Portable YetiSwarm packaging with a clean split between shareable skill code and local runtime state.

## Layout

- `skill/yetiswarm/`: distributable skill code, TypeScript sources, docs, templates.
- `runtime/example-state/`: example runtime layout only (no real secrets/state).
- `scripts/install.sh`: installs `skill/yetiswarm` to `${OPENCLAW_SKILLS_DIR:-~/.agents/skills}/yetiswarm`.

## Runtime Path Environment Variables

All runtime entrypoints support these variables:

- `SWARM_HOME`: base runtime directory.
- `SWARM_REPOS_FILE`: path to runtime `repos.json`.
- `SWARM_DB_PATH`: path to `swarm.db`.
- `SWARM_LOGS_DIR`: path to logs directory.

Behavior and compatibility:

- If `SWARM_HOME` is set, other relative runtime paths resolve from it.
- If path vars are set directly, they override defaults.
- If none are set, runtime falls back to legacy auto-discovery (current dir if it looks like a swarm runtime, otherwise entrypoint-relative detection).

## Install

```bash
./scripts/install.sh
```

Then in the installed skill directory:

```bash
cd "${OPENCLAW_SKILLS_DIR:-$HOME/.agents/skills}/yetiswarm"
cp repos.example.json repos.json
cp .env.example .env
npm install
npm run build
```

`repos.json` is intentionally local-only and gitignored.

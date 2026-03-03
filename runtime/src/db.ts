import { DatabaseSync } from "node:sqlite";

const TASKS_TABLE = `
CREATE TABLE IF NOT EXISTS tasks (
    id                        TEXT PRIMARY KEY,
    repo_key                  TEXT NOT NULL,
    repo_dir                  TEXT NOT NULL,
    gh_repo                   TEXT NOT NULL,
    tmux_session              TEXT NOT NULL DEFAULT '',
    agent                     TEXT NOT NULL,
    model                     TEXT NOT NULL,
    thinking                  TEXT NOT NULL,
    branch                    TEXT NOT NULL,
    worktree                  TEXT NOT NULL DEFAULT '',
    depends_on                TEXT NOT NULL DEFAULT '[]',
    parent_task_id            TEXT DEFAULT NULL,
    blocked_reason            TEXT NOT NULL DEFAULT '',
    started_at                INTEGER NOT NULL,
    status                    TEXT NOT NULL,
    retries                   INTEGER NOT NULL DEFAULT 0,
    pr                        INTEGER DEFAULT NULL,
    pr_url                    TEXT DEFAULT NULL,
    original_prompt           TEXT NOT NULL DEFAULT '',
    prompt                    TEXT NOT NULL DEFAULT '',
    notify_on_complete        INTEGER NOT NULL DEFAULT 1,
    checks                    TEXT NOT NULL DEFAULT '{}',
    completed_at              INTEGER DEFAULT NULL,
    comment_fix_retries       INTEGER NOT NULL DEFAULT 0,
    last_processed_comment_at TEXT NOT NULL DEFAULT '',
    notify_channel            TEXT NOT NULL DEFAULT 'discord',
    notify_target             TEXT NOT NULL DEFAULT '',
    notify_reply_to           TEXT NOT NULL DEFAULT '',
    pid                       INTEGER DEFAULT NULL,
    container_id              TEXT DEFAULT NULL
)
`;

const EVENTS_TABLE = `
CREATE TABLE IF NOT EXISTS task_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    old_status  TEXT DEFAULT NULL,
    new_status  TEXT DEFAULT NULL,
    detail      TEXT DEFAULT NULL,
    created_at  INTEGER NOT NULL
)
`;

const EVENTS_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_events_task_id ON task_events(task_id)",
  "CREATE INDEX IF NOT EXISTS idx_events_created_at ON task_events(created_at)",
];

const TASK_COLUMN_MIGRATIONS: Array<{ name: string; sql: string }> = [
  {
    name: "depends_on",
    sql: "ALTER TABLE tasks ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]'",
  },
  {
    name: "parent_task_id",
    sql: "ALTER TABLE tasks ADD COLUMN parent_task_id TEXT DEFAULT NULL",
  },
  {
    name: "blocked_reason",
    sql: "ALTER TABLE tasks ADD COLUMN blocked_reason TEXT NOT NULL DEFAULT ''",
  },
  {
    name: "notify_channel",
    sql: "ALTER TABLE tasks ADD COLUMN notify_channel TEXT NOT NULL DEFAULT 'discord'",
  },
  {
    name: "notify_target",
    sql: "ALTER TABLE tasks ADD COLUMN notify_target TEXT NOT NULL DEFAULT ''",
  },
  {
    name: "notify_reply_to",
    sql: "ALTER TABLE tasks ADD COLUMN notify_reply_to TEXT NOT NULL DEFAULT ''",
  },
];

function ensureTaskColumns(db: DatabaseSync): void {
  const rows = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name?: string }>;
  const existing = new Set(rows.map((row) => String(row.name ?? "")));

  for (const migration of TASK_COLUMN_MIGRATIONS) {
    if (existing.has(migration.name)) {
      continue;
    }
    db.exec(migration.sql);
  }
}

export function openDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=30000");
  db.exec("PRAGMA foreign_keys=ON");
  return db;
}

export function withConnection<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  const db = openDatabase(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function initDb(dbPath: string): void {
  withConnection(dbPath, (db) => {
    db.exec(TASKS_TABLE);
    ensureTaskColumns(db);
    db.exec(EVENTS_TABLE);
    for (const idx of EVENTS_INDEXES) {
      db.exec(idx);
    }
  });
}

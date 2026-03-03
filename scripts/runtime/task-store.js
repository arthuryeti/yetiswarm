import fs from "node:fs";
import path from "node:path";
import { initDb, withConnection } from "./db.js";
const KEY_MAP = {
    id: "id",
    repoKey: "repo_key",
    repoDir: "repo_dir",
    ghRepo: "gh_repo",
    tmuxSession: "tmux_session",
    agent: "agent",
    model: "model",
    thinking: "thinking",
    branch: "branch",
    worktree: "worktree",
    dependsOn: "depends_on",
    parentTaskId: "parent_task_id",
    blockedReason: "blocked_reason",
    startedAt: "started_at",
    status: "status",
    retries: "retries",
    pr: "pr",
    prUrl: "pr_url",
    originalPrompt: "original_prompt",
    prompt: "prompt",
    notifyOnComplete: "notify_on_complete",
    checks: "checks",
    completedAt: "completed_at",
    commentFixRetries: "comment_fix_retries",
    conflictFixRetries: "conflict_fix_retries",
    lastProcessedCommentAt: "last_processed_comment_at",
    notifyChannel: "notify_channel",
    notifyTarget: "notify_target",
    notifyReplyTo: "notify_reply_to",
    pid: "pid",
    containerId: "container_id",
};
const REVERSE_KEY_MAP = Object.fromEntries(Object.entries(KEY_MAP).map(([k, v]) => [v, k]));
const TASK_COLUMNS = [
    "id",
    "repo_key",
    "repo_dir",
    "gh_repo",
    "tmux_session",
    "agent",
    "model",
    "thinking",
    "branch",
    "worktree",
    "depends_on",
    "parent_task_id",
    "blocked_reason",
    "started_at",
    "status",
    "retries",
    "pr",
    "pr_url",
    "original_prompt",
    "prompt",
    "notify_on_complete",
    "checks",
    "completed_at",
    "comment_fix_retries",
    "conflict_fix_retries",
    "last_processed_comment_at",
    "notify_channel",
    "notify_target",
    "notify_reply_to",
    "pid",
    "container_id",
];
function parseJson(text, fallback) {
    try {
        return JSON.parse(text);
    }
    catch {
        return fallback;
    }
}
function nowMs() {
    return Date.now();
}
function rowToTask(row) {
    const checksRaw = row.checks;
    const checks = typeof checksRaw === "string"
        ? parseJson(checksRaw, {})
        : checksRaw ?? {};
    const dependsOnRaw = row.depends_on;
    const dependsOn = Array.isArray(dependsOnRaw)
        ? dependsOnRaw.map((v) => String(v))
        : typeof dependsOnRaw === "string"
            ? parseJson(dependsOnRaw, [])
            : [];
    return {
        id: String(row.id ?? ""),
        repo_key: String(row.repo_key ?? ""),
        repo_dir: String(row.repo_dir ?? ""),
        gh_repo: String(row.gh_repo ?? ""),
        tmux_session: String(row.tmux_session ?? ""),
        agent: String(row.agent ?? ""),
        model: String(row.model ?? ""),
        thinking: String(row.thinking ?? ""),
        branch: String(row.branch ?? ""),
        worktree: String(row.worktree ?? ""),
        depends_on: dependsOn.filter(Boolean),
        parent_task_id: row.parent_task_id == null ? null : String(row.parent_task_id),
        blocked_reason: String(row.blocked_reason ?? ""),
        started_at: Number(row.started_at ?? 0),
        status: String(row.status ?? ""),
        retries: Number(row.retries ?? 0),
        pr: row.pr == null || row.pr === "" ? null : Number(row.pr),
        pr_url: row.pr_url == null ? null : String(row.pr_url),
        original_prompt: String(row.original_prompt ?? ""),
        prompt: String(row.prompt ?? ""),
        notify_on_complete: Boolean(row.notify_on_complete ?? 1),
        checks,
        completed_at: row.completed_at == null || row.completed_at === "" ? null : Number(row.completed_at),
        comment_fix_retries: Number(row.comment_fix_retries ?? 0),
        conflict_fix_retries: Number(row.conflict_fix_retries ?? 0),
        last_processed_comment_at: String(row.last_processed_comment_at ?? ""),
        notify_channel: String(row.notify_channel ?? "discord"),
        notify_target: String(row.notify_target ?? ""),
        notify_reply_to: String(row.notify_reply_to ?? ""),
        pid: row.pid == null || row.pid === "" ? null : Number(row.pid),
        container_id: row.container_id == null ? null : String(row.container_id),
    };
}
function taskToRow(task) {
    return {
        ...task,
        depends_on: JSON.stringify(task.depends_on ?? []),
        checks: JSON.stringify(task.checks ?? {}),
        notify_on_complete: task.notify_on_complete ? 1 : 0,
    };
}
function logEvent(db, taskId, eventType, oldStatus = null, newStatus = null, detail = null) {
    const stmt = db.prepare("INSERT INTO task_events (task_id, event_type, old_status, new_status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)");
    stmt.run(taskId, eventType, oldStatus, newStatus, detail, nowMs());
}
function defaultTask() {
    return {
        id: "",
        repo_key: "",
        repo_dir: "",
        gh_repo: "",
        tmux_session: "",
        agent: "",
        model: "",
        thinking: "",
        branch: "",
        worktree: "",
        depends_on: [],
        parent_task_id: null,
        blocked_reason: "",
        started_at: 0,
        status: "",
        retries: 0,
        pr: null,
        pr_url: null,
        original_prompt: "",
        prompt: "",
        notify_on_complete: true,
        checks: {},
        completed_at: null,
        comment_fix_retries: 0,
        conflict_fix_retries: 0,
        last_processed_comment_at: "",
        notify_channel: "discord",
        notify_target: "",
        notify_reply_to: "",
        pid: null,
        container_id: null,
    };
}
function pickTaskColumns(task) {
    const out = {};
    for (const c of TASK_COLUMNS) {
        out[c] = task[c];
    }
    return out;
}
export function taskFromDict(d) {
    const base = defaultTask();
    for (const [jsonKey, pyKey] of Object.entries(KEY_MAP)) {
        if (Object.prototype.hasOwnProperty.call(d, jsonKey)) {
            base[pyKey] = d[jsonKey];
        }
    }
    if (typeof base.checks === "string") {
        base.checks = parseJson(base.checks, {});
    }
    if (typeof base.depends_on === "string") {
        base.depends_on = parseJson(base.depends_on, []);
    }
    if (!Array.isArray(base.depends_on)) {
        base.depends_on = [];
    }
    base.depends_on = base.depends_on.map((v) => String(v)).filter(Boolean);
    base.notify_on_complete = Boolean(base.notify_on_complete);
    return base;
}
export function taskToDict(task) {
    const result = {};
    for (const [k, v] of Object.entries(task)) {
        if (k === "_approved") {
            continue;
        }
        const jsonKey = REVERSE_KEY_MAP[k] ?? k;
        result[jsonKey] = v;
    }
    const optionalDefaults = {
        dependsOn: [],
        parentTaskId: null,
        blockedReason: "",
        completedAt: null,
        commentFixRetries: 0,
        conflictFixRetries: 0,
        lastProcessedCommentAt: "",
        notifyChannel: "discord",
        notifyTarget: "",
        notifyReplyTo: "",
        pid: null,
        containerId: null,
    };
    for (const [k, def] of Object.entries(optionalDefaults)) {
        if (result[k] === def) {
            delete result[k];
        }
    }
    return result;
}
export class TaskStore {
    dbPath;
    constructor(dbPath) {
        if (dbPath.endsWith(".json")) {
            dbPath = path.join(path.dirname(dbPath) || ".", "swarm.db");
        }
        this.dbPath = dbPath;
        initDb(this.dbPath);
    }
    load() {
        return withConnection(this.dbPath, (db) => {
            const rows = db.prepare("SELECT * FROM tasks").all();
            return rows.map(rowToTask);
        });
    }
    save(tasks) {
        withConnection(this.dbPath, (db) => {
            db.exec("BEGIN IMMEDIATE");
            try {
                db.exec("DELETE FROM tasks");
                const cols = TASK_COLUMNS.join(", ");
                const placeholders = TASK_COLUMNS.map(() => "?").join(", ");
                const stmt = db.prepare(`INSERT INTO tasks (${cols}) VALUES (${placeholders})`);
                for (const t of tasks) {
                    const row = taskToRow(pickTaskColumns(t));
                    stmt.run(...TASK_COLUMNS.map((c) => row[c]));
                }
                db.exec("COMMIT");
            }
            catch (err) {
                db.exec("ROLLBACK");
                throw err;
            }
        });
    }
    listRunning() {
        return withConnection(this.dbPath, (db) => {
            const rows = db
                .prepare("SELECT * FROM tasks WHERE status IN ('running', 'done', 'needs-review')")
                .all();
            return rows.map(rowToTask);
        });
    }
    countRunning() {
        return withConnection(this.dbPath, (db) => {
            const row = db
                .prepare("SELECT COUNT(*) AS count FROM tasks WHERE status IN ('running', 'done', 'needs-review')")
                .get();
            return Number(row?.count ?? 0);
        });
    }
    listMonitorCandidates() {
        return withConnection(this.dbPath, (db) => {
            const rows = db
                .prepare("SELECT * FROM tasks WHERE status IN ('running', 'done', 'needs-review') OR (status = 'failed' AND pr IS NOT NULL)")
                .all();
            return rows.map(rowToTask);
        });
    }
    countMonitorCandidates() {
        return withConnection(this.dbPath, (db) => {
            const row = db
                .prepare("SELECT COUNT(*) AS count FROM tasks WHERE status IN ('running', 'done', 'needs-review') OR (status = 'failed' AND pr IS NOT NULL)")
                .get();
            return Number(row?.count ?? 0);
        });
    }
    getTask(taskId) {
        return withConnection(this.dbPath, (db) => {
            const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
            return row ? rowToTask(row) : null;
        });
    }
    patchTask(taskId, patch) {
        withConnection(this.dbPath, (db) => {
            const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
            if (!row) {
                return;
            }
            const oldStatus = String(row.status ?? "");
            const patchCopy = { ...patch };
            if (Object.prototype.hasOwnProperty.call(patchCopy, "checks")) {
                const existingChecks = typeof row.checks === "string"
                    ? parseJson(row.checks, {})
                    : row.checks ?? {};
                const nextChecks = patchCopy.checks;
                patchCopy.checks = JSON.stringify({ ...existingChecks, ...(nextChecks ?? {}) });
            }
            const updates = {};
            for (const [incomingKey, valueRaw] of Object.entries(patchCopy)) {
                const snakeKey = KEY_MAP[incomingKey] || incomingKey;
                let value = valueRaw;
                if (snakeKey === "notify_on_complete") {
                    value = value ? 1 : 0;
                }
                else if (snakeKey === "depends_on") {
                    if (Array.isArray(value)) {
                        value = JSON.stringify(value.map((v) => String(v)).filter(Boolean));
                    }
                    else if (typeof value === "string") {
                        const parsed = parseJson(value, []);
                        value = JSON.stringify(parsed.map((v) => String(v)).filter(Boolean));
                    }
                    else {
                        value = "[]";
                    }
                }
                else if (snakeKey === "checks" && typeof value === "object" && value !== null) {
                    value = JSON.stringify(value);
                }
                updates[snakeKey] = value;
            }
            if (Object.keys(updates).length === 0) {
                return;
            }
            const setClause = Object.keys(updates)
                .map((k) => `${k} = ?`)
                .join(", ");
            const values = [...Object.values(updates), taskId];
            db.prepare(`UPDATE tasks SET ${setClause} WHERE id = ?`).run(...values);
            const newStatus = updates.status;
            if (typeof newStatus === "string" && newStatus !== oldStatus) {
                logEvent(db, taskId, "status_change", oldStatus, newStatus, null);
            }
        });
    }
    removeTask(taskId) {
        withConnection(this.dbPath, (db) => {
            const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId);
            db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
            if (row) {
                logEvent(db, taskId, "removed", row.status ?? null, null, "task removed");
            }
        });
    }
    registerTask(taskJson) {
        const taskData = parseJson(taskJson, {});
        const taskId = String(taskData.id ?? "");
        if (!taskId) {
            return;
        }
        withConnection(this.dbPath, (db) => {
            const existing = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
            if (existing) {
                for (const [camel, snake] of [
                    ["retries", "retries"],
                    ["pr", "pr"],
                    ["prUrl", "pr_url"],
                ]) {
                    const current = existing[snake];
                    if (current !== null && current !== undefined) {
                        taskData[camel] = current;
                    }
                }
                for (const [camel, snake] of [
                    ["originalPrompt", "original_prompt"],
                    ["commentFixRetries", "comment_fix_retries"],
                    ["conflictFixRetries", "conflict_fix_retries"],
                    ["lastProcessedCommentAt", "last_processed_comment_at"],
                    ["dependsOn", "depends_on"],
                    ["parentTaskId", "parent_task_id"],
                    ["notifyChannel", "notify_channel"],
                    ["notifyTarget", "notify_target"],
                    ["notifyReplyTo", "notify_reply_to"],
                ]) {
                    if (!Object.prototype.hasOwnProperty.call(taskData, camel) && existing[snake]) {
                        taskData[camel] = existing[snake];
                    }
                }
            }
            const row = {};
            for (const [camelKey, valueRaw] of Object.entries(taskData)) {
                const snakeKey = KEY_MAP[camelKey] || camelKey;
                let value = valueRaw;
                if (snakeKey === "checks") {
                    if (typeof value === "object" && value !== null) {
                        value = JSON.stringify(value);
                    }
                }
                else if (snakeKey === "depends_on") {
                    if (Array.isArray(value)) {
                        value = JSON.stringify(value.map((v) => String(v)).filter(Boolean));
                    }
                    else if (typeof value === "string") {
                        const parsed = parseJson(value, []);
                        value = JSON.stringify(parsed.map((v) => String(v)).filter(Boolean));
                    }
                    else {
                        value = "[]";
                    }
                }
                else if (snakeKey === "notify_on_complete") {
                    value = value ? 1 : 0;
                }
                row[snakeKey] = value;
            }
            const cols = Object.keys(row);
            const placeholders = cols.map(() => "?").join(", ");
            const sql = `INSERT OR REPLACE INTO tasks (${cols.join(", ")}) VALUES (${placeholders})`;
            db.prepare(sql).run(...cols.map((c) => row[c]));
            const statusVal = row.status == null ? null : String(row.status);
            logEvent(db, taskId, "registered", null, statusVal, existing ? "re-registered" : "new task");
        });
    }
    getPrUrl(taskId) {
        return withConnection(this.dbPath, (db) => {
            const row = db.prepare("SELECT pr_url FROM tasks WHERE id = ?").get(taskId);
            return row?.pr_url ?? "";
        });
    }
    hasEvent(taskId, eventType) {
        return withConnection(this.dbPath, (db) => {
            const row = db
                .prepare("SELECT 1 AS present FROM task_events WHERE task_id = ? AND event_type = ? LIMIT 1")
                .get(taskId, eventType);
            return Boolean(row?.present);
        });
    }
    addEvent(taskId, eventType, detail = null) {
        withConnection(this.dbPath, (db) => {
            const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId);
            logEvent(db, taskId, eventType, row?.status ?? null, row?.status ?? null, detail);
        });
    }
    claimPrEvent(eventType, ghRepo, prNumber, taskId = "") {
        if (!eventType || !ghRepo || !Number.isFinite(prNumber) || prNumber <= 0) {
            return false;
        }
        const detail = `${ghRepo}#${prNumber}`;
        const owner = taskId || `pr:${detail}`;
        return withConnection(this.dbPath, (db) => {
            const result = db
                .prepare(`INSERT INTO task_events (task_id, event_type, old_status, new_status, detail, created_at)
           SELECT ?, ?, NULL, NULL, ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM task_events WHERE event_type = ? AND detail = ? LIMIT 1
           )`)
                .run(owner, eventType, detail, nowMs(), eventType, detail);
            return Number(result?.changes ?? 0) > 0;
        });
    }
    areDependenciesMerged(dependsOn) {
        const deps = dependsOn.map((d) => d.trim()).filter(Boolean);
        if (!deps.length) {
            return true;
        }
        return deps.every((depTaskId) => {
            if (this.hasEvent(depTaskId, "merged")) {
                return true;
            }
            if (!this.getTask(depTaskId) && this.hasEvent(depTaskId, "removed")) {
                return true;
            }
            return false;
        });
    }
}
export function parsePrData(jsonStr) {
    const data = parseJson(jsonStr || "[]", []);
    if (!data.length) {
        return [null, null];
    }
    const stateRank = (item) => {
        const state = String(item.state ?? "").toUpperCase();
        if (state === "OPEN")
            return 0;
        if (state === "MERGED")
            return 1;
        if (item.mergedAt)
            return 1;
        if (state === "CLOSED")
            return 2;
        return 3;
    };
    const best = [...data].sort((a, b) => stateRank(a) - stateRank(b))[0] ?? {};
    const numberVal = best.number == null ? null : Number(best.number);
    const urlVal = best.url == null ? null : String(best.url);
    return [numberVal, urlVal];
}
export function parseReviews(jsonStr) {
    const data = parseJson(jsonStr || "[]", []);
    const latestByReviewer = {};
    data.forEach((review, idx) => {
        const authorObj = review.author || {};
        const author = String(authorObj.login ?? `unknown-${idx}`);
        const state = String(review.state ?? "");
        const submittedAt = String(review.submittedAt ?? review.submitted_at ?? "");
        const prev = latestByReviewer[author];
        if (!prev || submittedAt >= prev[0]) {
            latestByReviewer[author] = [submittedAt, state];
        }
    });
    const finalStates = {};
    for (const [author, value] of Object.entries(latestByReviewer)) {
        finalStates[author] = value[1];
    }
    const approved = Object.entries(finalStates)
        .filter(([, state]) => state === "APPROVED")
        .map(([author]) => author);
    const changes = Object.entries(finalStates)
        .filter(([, state]) => state === "CHANGES_REQUESTED")
        .map(([author]) => author);
    return [approved.length, changes.length, changes.join(", ")];
}
export function parseCiStatus(jsonStr) {
    const checks = parseJson(jsonStr || "[]", []);
    if (!checks.length) {
        return "pass";
    }
    if (checks.every((c) => c.state === "SUCCESS")) {
        return "pass";
    }
    if (checks.some((c) => ["FAILURE", "ERROR", "CANCELLED"].includes(String(c.state ?? "")))) {
        return "fail";
    }
    return "pending";
}
export function formatPrFeedback(reviewsJson, commentsJson, since = "") {
    const reviews = parseJson(reviewsJson || "[]", []);
    const comments = parseJson(commentsJson || "[]", []);
    const actionableReviews = reviews.filter((r) => {
        if (r.state !== "CHANGES_REQUESTED") {
            return false;
        }
        const submittedAt = String(r.submitted_at ?? "");
        if (since && submittedAt <= since) {
            return false;
        }
        return true;
    });
    const actionableIds = new Set(actionableReviews.map((r) => r.id));
    const standaloneComments = comments.filter((c) => {
        const createdAt = String(c.created_at ?? "");
        if (since && createdAt <= since) {
            return false;
        }
        return !actionableIds.has(c.pull_request_review_id);
    });
    if (!actionableReviews.length && !standaloneComments.length) {
        return null;
    }
    const timestamps = [];
    for (const r of actionableReviews) {
        const ts = String(r.submitted_at ?? "");
        if (ts)
            timestamps.push(ts);
    }
    for (const c of standaloneComments) {
        const ts = String(c.created_at ?? "");
        if (ts)
            timestamps.push(ts);
    }
    for (const c of comments) {
        if (actionableIds.has(c.pull_request_review_id)) {
            const ts = String(c.created_at ?? "");
            if (ts)
                timestamps.push(ts);
        }
    }
    const latestAt = timestamps.length ? timestamps.sort().slice(-1)[0] : "";
    const lines = [];
    for (const review of actionableReviews) {
        const userObj = review.user || {};
        const reviewer = String(userObj.login ?? "reviewer");
        const body = String(review.body ?? "").trim();
        const reviewId = review.id;
        lines.push(`## Review by @${reviewer} (Changes Requested)`);
        if (body) {
            lines.push(body);
        }
        lines.push("");
        const reviewComments = comments.filter((c) => c.pull_request_review_id === reviewId);
        for (const c of reviewComments) {
            const p = String(c.path ?? "");
            const lineNum = String(c.line ?? c.original_line ?? "");
            const commentBody = String(c.body ?? "").trim();
            if (!commentBody)
                continue;
            const loc = lineNum ? `${p}:${lineNum}` : p;
            lines.push(`### ${loc}`);
            lines.push(commentBody);
            lines.push("");
        }
    }
    if (standaloneComments.length) {
        lines.push("## Additional Inline Comments");
        lines.push("");
        for (const c of standaloneComments) {
            const p = String(c.path ?? "");
            const lineNum = String(c.line ?? c.original_line ?? "");
            const commentBody = String(c.body ?? "").trim();
            const userObj = c.user || {};
            const user = String(userObj.login ?? "reviewer");
            if (!commentBody)
                continue;
            const loc = lineNum ? `${p}:${lineNum}` : p;
            lines.push(`### ${loc} (@${user})`);
            lines.push(commentBody);
            lines.push("");
        }
    }
    if (!lines.length) {
        return null;
    }
    return [latestAt, lines.join("\n")];
}
export function loadReposFile(reposFile) {
    const raw = fs.readFileSync(reposFile, "utf8");
    const parsed = parseJson(raw, {});
    const repos = parsed.repos ?? {};
    return { repos };
}
export function saveReposFile(reposFile, data) {
    const sortedRepos = Object.fromEntries(Object.entries(data.repos).sort(([a], [b]) => a.localeCompare(b)));
    fs.writeFileSync(reposFile, `${JSON.stringify({ repos: sortedRepos }, null, 2)}\n`, "utf8");
}
export function upsertRepoConfig(reposFile, repoKey, entry) {
    const data = loadReposFile(reposFile);
    data.repos[repoKey] = entry;
    saveReposFile(reposFile, data);
}
export function loadRepoConfig(reposFile, repoKey) {
    const reposObj = loadReposFile(reposFile).repos;
    const r = reposObj[repoKey];
    if (!r) {
        return null;
    }
    const ghRepo = String(r.ghRepo ?? "");
    return {
        name: String(r.name ?? repoKey),
        path: String(r.path ?? ""),
        ghRepo,
        githubUrl: String(r.githubUrl ?? (ghRepo ? `https://github.com/${ghRepo}` : "")),
        description: String(r.description ?? ""),
        techStack: String(r.techStack ?? ""),
        worktrees: String(r.worktrees ?? ""),
        ciCmd: String(r.ciCmd ?? "npm run build"),
        installCmd: String(r.installCmd ?? "npm install --silent"),
        dockerCompose: Boolean(r.dockerCompose ?? false),
        promptPreamble: String(r.promptPreamble ?? ""),
    };
}
export function listRepoKeys(reposFile) {
    const reposObj = loadReposFile(reposFile).repos;
    return Object.keys(reposObj);
}

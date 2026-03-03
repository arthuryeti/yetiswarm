#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import util from "node:util";
import { _run, setupCronEnv, isAgentAlive, killAgent, gitWorktreeRemove, gitBranchDelete, } from "./shell.js";
import { spawnAgent } from "./run-agent.js";
import { TaskStore, parsePrData, parseReviews, parseCiStatus, formatPrFeedback, } from "./task-store.js";
import { resolveRuntimePaths } from "./runtime-paths.js";
let log;
function formatLine(args) {
    if (args.length === 0)
        return "";
    if (typeof args[0] === "string") {
        return util.format(args[0], ...args.slice(1));
    }
    return args.map((v) => String(v)).join(" ");
}
function setupLogging(logsDir) {
    fs.mkdirSync(logsDir, { recursive: true });
    const logFile = path.join(logsDir, "monitor.log");
    const write = (line) => {
        process.stdout.write(`${line}\n`);
        fs.appendFileSync(logFile, `${line}\n`, "utf8");
    };
    return {
        info: (...args) => write(formatLine(args)),
        warn: (...args) => write(formatLine(args)),
        error: (...args) => write(formatLine(args)),
        exception: (prefix, err) => {
            write(prefix);
            if (err instanceof Error) {
                write(err.stack || err.message);
            }
            else {
                write(String(err));
            }
        },
    };
}
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function tryAcquireLock(lockPath) {
    try {
        const fd = fs.openSync(lockPath, "wx");
        fs.writeFileSync(fd, `${process.pid}\n`);
        return { fd, lockPath };
    }
    catch (err) {
        const code = err.code;
        if (code !== "EEXIST") {
            return null;
        }
        let existingPid = 0;
        try {
            const raw = fs.readFileSync(lockPath, "utf8").trim();
            existingPid = Number(raw);
        }
        catch {
            // noop
        }
        if (existingPid > 0 && isProcessAlive(existingPid)) {
            return null;
        }
        try {
            fs.unlinkSync(lockPath);
        }
        catch {
            return null;
        }
        try {
            const fd = fs.openSync(lockPath, "wx");
            fs.writeFileSync(fd, `${process.pid}\n`);
            return { fd, lockPath };
        }
        catch {
            return null;
        }
    }
}
function acquireMonitorLock(swarmDir) {
    const lockPath = path.join(swarmDir, ".monitor.lock");
    return tryAcquireLock(lockPath);
}
function releaseMonitorLock(lock) {
    try {
        fs.closeSync(lock.fd);
    }
    catch {
        // noop
    }
    try {
        fs.unlinkSync(lock.lockPath);
    }
    catch {
        // noop
    }
}
function ghPrDetails(ctx, prNumber, ghRepo) {
    const result = _run([
        ctx.ghBin,
        "pr",
        "view",
        String(prNumber),
        "--repo",
        ghRepo,
        "--json",
        "state,title,isDraft,url",
    ]);
    if (result.returncode !== 0) {
        return { state: "", title: "", isDraft: false, url: "" };
    }
    try {
        const obj = JSON.parse(result.stdout || "{}");
        return {
            state: String(obj.state ?? ""),
            title: String(obj.title ?? ""),
            isDraft: Boolean(obj.isDraft ?? false),
            url: String(obj.url ?? ""),
        };
    }
    catch {
        return { state: "", title: "", isDraft: false, url: "" };
    }
}
function ghPrList(ctx, ghRepo, branch) {
    const result = _run([
        ctx.ghBin,
        "pr",
        "list",
        "--repo",
        ghRepo,
        "--head",
        branch,
        "--state",
        "all",
        "--json",
        "number,url,state,mergedAt,closedAt",
        "--limit",
        "20",
    ]);
    return result.returncode === 0 ? result.stdout.trim() : "[]";
}
function ghPrChecks(ctx, prNumber, ghRepo) {
    const result = _run([
        ctx.ghBin,
        "pr",
        "checks",
        String(prNumber),
        "--repo",
        ghRepo,
        "--json",
        "name,state",
    ]);
    return result.returncode === 0 ? result.stdout.trim() : "[]";
}
function ghPrReviews(ctx, prNumber, ghRepo) {
    const result = _run([
        ctx.ghBin,
        "pr",
        "view",
        String(prNumber),
        "--repo",
        ghRepo,
        "--json",
        "reviews",
        "-q",
        ".reviews",
    ]);
    return result.returncode === 0 ? result.stdout.trim() : "[]";
}
function ghApi(ctx, endpoint) {
    const result = _run([ctx.ghBin, "api", endpoint]);
    return result.returncode === 0 ? result.stdout.trim() : "[]";
}
function resolveNotifyConfig(ctx, task) {
    const channel = task.notify_channel || ctx.defaultNotifyChannel || "discord";
    const target = task.notify_target || ctx.defaultNotifyTarget || "";
    const replyTo = task.notify_reply_to || ctx.defaultNotifyReplyTo || "";
    return { channel, target, replyTo };
}
function sendMessage(channel, target, replyTo, message) {
    if (!target) {
        return;
    }
    const cmd = [
        "openclaw",
        "message",
        "send",
        "--channel",
        channel,
        "--target",
        target,
        "--message",
        message,
    ];
    if (replyTo) {
        cmd.push("--reply-to", replyTo);
    }
    _run(cmd);
}
function notifyTask(ctx, task, message) {
    const cfg = resolveNotifyConfig(ctx, task);
    sendMessage(cfg.channel, cfg.target, cfg.replyTo, message);
}
function taskRepoLabel(task) {
    return `${task.gh_repo || task.repo_key}`;
}
function buildPrMessage(action, task, detail) {
    const title = detail.title || "(no title)";
    const branch = detail.branch || task.branch;
    const status = detail.status || "Unknown";
    const prUrl = detail.prUrl || task.pr_url || "";
    const lines = [
        `🔀 PR ${action} — ${taskRepoLabel(task)}`,
        `Title: ${title}`,
        `Branch: ${branch} → main`,
        `Status: ${status}`,
    ];
    if (prUrl) {
        lines.push(`Link: ${prUrl}`);
    }
    if (detail.extra) {
        lines.push(detail.extra);
    }
    return lines.join("\n");
}
function checkFlag(task, key) {
    return Boolean(task.checks?.[key]);
}
function markFlag(ctx, task, key) {
    ctx.store.patchTask(task.id, { checks: { [key]: true } });
    task.checks = { ...(task.checks ?? {}), [key]: true };
}
function isSessionIdle(ctx, taskId) {
    const logFile = path.join(ctx.logsDir, `${taskId}.log`);
    if (!fs.existsSync(logFile)) {
        return false;
    }
    try {
        const st = fs.statSync(logFile);
        const ageSecs = (Date.now() - st.mtimeMs) / 1000;
        return ageSecs > ctx.idleTimeoutSecs;
    }
    catch {
        return false;
    }
}
function respawnTask(ctx, task, errorContext = "") {
    const newRetries = task.retries + 1;
    ctx.store.patchTask(task.id, { retries: newRetries, status: "running" });
    killAgent(task);
    let retryPrompt = task.original_prompt;
    if (errorContext) {
        retryPrompt =
            `${task.original_prompt}\n\n` +
                `IMPORTANT — This is retry attempt ${newRetries}/${ctx.maxRetries}. Previous attempt failed:\n` +
                `${errorContext}\n` +
                `Fix these issues, then push and update the existing PR (do NOT create a new one).`;
    }
    log.info("  Respawning %s (attempt %d/%d)", task.id, newRetries, ctx.maxRetries);
    spawnAgent({
        repoKey: task.repo_key,
        taskId: task.id,
        branch: task.branch,
        agent: task.agent,
        model: task.model,
        thinking: task.thinking,
        prompt: retryPrompt,
        notifyChannel: task.notify_channel,
        notifyTarget: task.notify_target,
        notifyReplyTo: task.notify_reply_to,
        swarmDir: ctx.swarmDir,
        reposFile: ctx.reposFile,
        dbPath: ctx.dbPath,
        logsDir: ctx.logsDir,
    });
}
function respawnForReview(ctx, task, commentRetries, feedbackText) {
    const newCommentRetries = commentRetries + 1;
    killAgent(task);
    const fixPrompt = `${task.original_prompt}\n\n` +
        `IMPORTANT — A reviewer has left feedback on your PR. ` +
        `This is review-fix attempt ${newCommentRetries}/${ctx.maxCommentRetries}.\n\n` +
        `Address ALL of the following review comments:\n${feedbackText}\n\n` +
        `After fixing:\n` +
        `1. Commit with a message like: fix: address PR review feedback\n` +
        `2. Push to the same branch (do NOT create a new PR)\n` +
        `3. Make sure the build still passes`;
    log.info("  Respawning %s for review fixes (attempt %d/%d)", task.id, newCommentRetries, ctx.maxCommentRetries);
    spawnAgent({
        repoKey: task.repo_key,
        taskId: task.id,
        branch: task.branch,
        agent: task.agent,
        model: task.model,
        thinking: task.thinking,
        prompt: fixPrompt,
        notifyChannel: task.notify_channel,
        notifyTarget: task.notify_target,
        notifyReplyTo: task.notify_reply_to,
        swarmDir: ctx.swarmDir,
        reposFile: ctx.reposFile,
        dbPath: ctx.dbPath,
        logsDir: ctx.logsDir,
    });
}
function determineState(task) {
    const hasPr = task.pr !== null && String(task.pr) !== "None";
    if (task.status === "failed" && hasPr) {
        return "CHECK_MERGE" /* TaskState.CHECK_MERGE */;
    }
    if ((task.status === "done" || task.status === "needs-review") && hasPr) {
        return "AWAITING_MERGE" /* TaskState.AWAITING_MERGE */;
    }
    return "CHECK_AGENT" /* TaskState.CHECK_AGENT */;
}
function handleAwaitingMerge(task, ctx) {
    const prDetails = ghPrDetails(ctx, Number(task.pr), task.gh_repo);
    if (prDetails.state === "MERGED") {
        return cleanupMergedTask(task, ctx, prDetails);
    }
    log.info("  PR #%s not yet merged (state: %s)", task.pr, prDetails.state || "unknown");
    return null;
}
function handleCheckAgent(task, ctx) {
    const agentAlive = isAgentAlive(task);
    const hasPr = task.pr !== null && String(task.pr) !== "None";
    if (agentAlive && task.status === "running") {
        if (isSessionIdle(ctx, task.id)) {
            const idleMin = Math.floor(ctx.idleTimeoutSecs / 60);
            log.info("  Agent alive but idle for >%dmin — treating as hung", idleMin);
            killAgent(task);
        }
    }
    if (!hasPr) {
        return "DETECT_PR" /* TaskState.DETECT_PR */;
    }
    return "CHECK_MERGE" /* TaskState.CHECK_MERGE */;
}
function handleAgentDeadNoPr(task, ctx) {
    if (task.retries < ctx.maxRetries) {
        log.info("  Session dead, no PR — respawning");
        notifyTask(ctx, task, `⚠️ \`${task.id}\` died before creating a PR. Respawning (attempt ${task.retries + 1}/${ctx.maxRetries})...`);
        respawnTask(ctx, task, "Agent process died before creating a PR.");
    }
    else {
        ctx.store.patchTask(task.id, { status: "failed" });
        notifyTask(ctx, task, buildPrMessage("Failed", task, {
            status: "Failed before PR creation",
            extra: `Reason: agent died before creating a PR after ${ctx.maxRetries} attempts`,
        }));
    }
    return null;
}
function handleDetectPr(task, ctx) {
    const prData = ghPrList(ctx, task.gh_repo, task.branch);
    const [prNumber, prUrl] = parsePrData(prData);
    if (prNumber !== null) {
        log.info("  PR #%s found", prNumber);
        ctx.store.patchTask(task.id, { pr: prNumber, prUrl: prUrl });
        task.pr = prNumber;
        task.pr_url = prUrl;
        if (!checkFlag(task, "pr_created_notified")) {
            const prDetails = ghPrDetails(ctx, prNumber, task.gh_repo);
            notifyTask(ctx, task, buildPrMessage("Created", task, {
                title: prDetails.title || `PR #${prNumber}`,
                status: prDetails.isDraft ? "Draft" : "Ready for review",
                prUrl: prDetails.url || prUrl || "",
            }));
            markFlag(ctx, task, "pr_created_notified");
        }
        return "CHECK_MERGE" /* TaskState.CHECK_MERGE */;
    }
    const alive = isAgentAlive(task);
    log.info("  Still working (agent alive: %s)", alive);
    if (!alive) {
        return "AGENT_DEAD_NO_PR" /* TaskState.AGENT_DEAD_NO_PR */;
    }
    return null;
}
function handleCheckMerge(task, ctx) {
    const prUrl = ctx.store.getPrUrl(task.id) || task.pr_url || "";
    task.pr_url = prUrl;
    const prDetails = ghPrDetails(ctx, Number(task.pr), task.gh_repo);
    if (prDetails.state === "MERGED") {
        return cleanupMergedTask(task, ctx, prDetails);
    }
    return "CHECK_CI" /* TaskState.CHECK_CI */;
}
function ghPrMergeable(ctx, prNumber, ghRepo) {
    const result = _run([
        ctx.ghBin,
        "pr",
        "view",
        String(prNumber),
        "--repo",
        ghRepo,
        "--json",
        "mergeable",
        "-q",
        ".mergeable",
    ]);
    return result.returncode === 0 ? result.stdout.trim() : "";
}
function handleConflicts(task, ctx) {
    const mergeable = ghPrMergeable(ctx, Number(task.pr), task.gh_repo);
    if (mergeable !== "CONFLICTING") {
        return null; // no conflicts, continue to next check
    }
    const commentRetries = (() => {
        const rawTask = ctx.store.getTask(task.id);
        return rawTask ? rawTask.conflict_fix_retries ?? 0 : 0;
    })();
    const maxConflictRetries = ctx.maxRetries;
    if (commentRetries >= maxConflictRetries) {
        log.info("  PR #%s has conflicts — max retries exhausted (%d)", task.pr, maxConflictRetries);
        ctx.store.patchTask(task.id, { status: "needs-review" });
        notifyTask(ctx, task, buildPrMessage("Conflict", task, {
            status: "Merge conflicts",
            prUrl: task.pr_url || "",
            extra: `Reason: merge conflicts persist after ${maxConflictRetries} auto-fix attempts. Manual resolution needed.`,
        }));
        return "CHECK_CI" /* TaskState.CHECK_CI */; // skip to CI, let normal flow continue
    }
    log.info("  PR #%s has merge conflicts — spawning agent to fix (attempt %d/%d)", task.pr, commentRetries + 1, maxConflictRetries);
    ctx.store.patchTask(task.id, {
        conflictFixRetries: commentRetries + 1,
        status: "running",
    });
    notifyTask(ctx, task, `🔀 \`${task.id}\` has merge conflicts — auto-resolving (attempt ${commentRetries + 1}/${maxConflictRetries})...`);
    killAgent(task);
    const rebasePrompt = `${task.original_prompt}\n\n` +
        `IMPORTANT — Your PR has MERGE CONFLICTS with main. This is conflict-fix attempt ${commentRetries + 1}/${maxConflictRetries}.\n\n` +
        `Steps:\n` +
        `1. Run: git fetch origin main\n` +
        `2. Run: git rebase origin/main\n` +
        `3. Resolve ALL merge conflicts (keep your changes where they make sense, incorporate main's changes where needed)\n` +
        `4. Run: npm run build (make sure it still compiles)\n` +
        `5. Run: git push --force-with-lease\n` +
        `6. Do NOT create a new PR — just fix the existing branch`;
    spawnAgent({
        repoKey: task.repo_key,
        taskId: task.id,
        branch: task.branch,
        agent: task.agent,
        model: task.model,
        thinking: task.thinking,
        prompt: rebasePrompt,
        notifyChannel: task.notify_channel,
        notifyTarget: task.notify_target,
        notifyReplyTo: task.notify_reply_to,
        swarmDir: ctx.swarmDir,
        reposFile: ctx.reposFile,
        dbPath: ctx.dbPath,
        logsDir: ctx.logsDir,
    });
    return null; // stop processing, agent will fix it
}
function handleCheckCi(task, ctx) {
    // Check for merge conflicts first
    const conflictResult = handleConflicts(task, ctx);
    if (conflictResult === null && ghPrMergeable(ctx, Number(task.pr), task.gh_repo) === "CONFLICTING") {
        return null; // agent spawned to fix conflicts, stop here
    }
    const ciJson = ghPrChecks(ctx, Number(task.pr), task.gh_repo);
    const ciStatus = parseCiStatus(ciJson);
    const prUrl = task.pr_url || "";
    if (ciStatus === "fail") {
        if (task.status === "failed" && task.retries >= ctx.maxRetries) {
            log.info("  CI still failing for previously failed task #%s", task.pr);
            return null;
        }
        if (task.retries < ctx.maxRetries) {
            notifyTask(ctx, task, `🔁 \`${task.id}\` CI failed — auto-fixing (attempt ${task.retries + 1}/${ctx.maxRetries})...`);
            respawnTask(ctx, task, "CI checks failed. Check build output and fix errors.");
        }
        else {
            ctx.store.patchTask(task.id, { status: "failed" });
            notifyTask(ctx, task, buildPrMessage("Failed", task, {
                status: "CI failed",
                prUrl,
                extra: `Reason: CI still failing after ${ctx.maxRetries} attempts`,
            }));
        }
        return null;
    }
    if (ciStatus === "pending") {
        log.info("  CI pending...");
        return null;
    }
    return "CHECK_REVIEWS" /* TaskState.CHECK_REVIEWS */;
}
function handleCheckReviews(task, ctx) {
    const reviewsJson = ghPrReviews(ctx, Number(task.pr), task.gh_repo);
    const [approved, changes, reviewers] = parseReviews(reviewsJson);
    const prUrl = task.pr_url || "";
    if (changes > 0) {
        if (isAgentAlive(task)) {
            log.info("  Changes requested but agent still working — waiting...");
            return null;
        }
        const rawTask = ctx.store.getTask(task.id);
        const commentRetries = rawTask ? rawTask.comment_fix_retries : 0;
        if (commentRetries < ctx.maxCommentRetries) {
            const reviewsApi = ghApi(ctx, `repos/${task.gh_repo}/pulls/${task.pr}/reviews`);
            const commentsApi = ghApi(ctx, `repos/${task.gh_repo}/pulls/${task.pr}/comments`);
            const lastProcessed = rawTask ? rawTask.last_processed_comment_at : "";
            const feedback = formatPrFeedback(reviewsApi, commentsApi, lastProcessed);
            if (feedback) {
                const [latestAt, commentText] = feedback;
                const newCommentRetries = commentRetries + 1;
                ctx.store.patchTask(task.id, {
                    commentFixRetries: newCommentRetries,
                    lastProcessedCommentAt: latestAt,
                    status: "running",
                });
                notifyTask(ctx, task, `🔧 \`${task.id}\` — auto-fixing review feedback from ${reviewers} (attempt ${newCommentRetries}/${ctx.maxCommentRetries})...\nPR: ${prUrl}`);
                respawnForReview(ctx, task, commentRetries, commentText);
            }
            else {
                ctx.store.patchTask(task.id, { status: "needs-review" });
                notifyTask(ctx, task, buildPrMessage("Review Requested", task, {
                    status: "Changes requested",
                    prUrl,
                    extra: `Reviewers: ${reviewers} (no inline comments found)`,
                }));
            }
        }
        else {
            ctx.store.patchTask(task.id, { status: "needs-review" });
            notifyTask(ctx, task, buildPrMessage("Failed", task, {
                status: "Review fixes exhausted",
                prUrl,
                extra: `Reviewers: ${reviewers} · retries: ${ctx.maxCommentRetries}`,
            }));
        }
        return null;
    }
    task._approved = approved;
    return "ALL_GREEN" /* TaskState.ALL_GREEN */;
}
function handleAllGreen(task, ctx) {
    const completedAt = Date.now();
    ctx.store.patchTask(task.id, { status: "done", completedAt });
    const prUrl = task.pr_url || "";
    const approved = task._approved ?? 0;
    log.info("  Done! PR #%s ready", task.pr);
    const prDetails = ghPrDetails(ctx, Number(task.pr), task.gh_repo);
    notifyTask(ctx, task, buildPrMessage("Ready", task, {
        title: prDetails.title || `PR #${task.pr}`,
        status: "Ready for review",
        prUrl: prDetails.url || prUrl,
        extra: `CI passing · ${approved} review(s)`,
    }));
    return null;
}
function cleanupMergedTask(task, ctx, prDetails) {
    log.info("  PR #%s merged — cleaning up", task.pr);
    const details = prDetails ?? ghPrDetails(ctx, Number(task.pr), task.gh_repo);
    const prNumber = Number(task.pr);
    const shouldNotifyMerged = Number.isFinite(prNumber) && prNumber > 0
        ? ctx.store.claimPrEvent("pr_merged_notified", task.gh_repo, prNumber, task.id)
        : !checkFlag(task, "pr_merged_notified");
    if (shouldNotifyMerged) {
        if (!checkFlag(task, "pr_merged_notified")) {
            // Mark first so retried monitor passes do not duplicate merged notifications.
            markFlag(ctx, task, "pr_merged_notified");
        }
        notifyTask(ctx, task, buildPrMessage("Merged", task, {
            title: details.title || `PR #${task.pr}`,
            status: "Merged",
            prUrl: details.url || task.pr_url || "",
        }));
    }
    else {
        log.info("  Merged notification already sent for PR #%s", task.pr);
    }
    if (!ctx.store.hasEvent(task.id, "merged")) {
        ctx.store.addEvent(task.id, "merged", `PR #${task.pr ?? "?"} merged`);
    }
    killAgent(task);
    if (task.worktree && fs.existsSync(task.worktree) && task.repo_dir) {
        const removed = gitWorktreeRemove(task.repo_dir, task.worktree);
        if (!removed) {
            log.warn("  Failed to remove worktree: %s", task.worktree);
        }
    }
    if (task.repo_dir && task.branch) {
        const deleted = gitBranchDelete(task.repo_dir, task.branch, true);
        if (!deleted) {
            log.info("  Local branch not deleted (already absent/in use): %s", task.branch);
        }
    }
    ctx.store.removeTask(task.id);
    return null;
}
const HANDLERS = {
    ["AWAITING_MERGE" /* TaskState.AWAITING_MERGE */]: handleAwaitingMerge,
    ["CHECK_AGENT" /* TaskState.CHECK_AGENT */]: handleCheckAgent,
    ["AGENT_DEAD_NO_PR" /* TaskState.AGENT_DEAD_NO_PR */]: handleAgentDeadNoPr,
    ["DETECT_PR" /* TaskState.DETECT_PR */]: handleDetectPr,
    ["CHECK_MERGE" /* TaskState.CHECK_MERGE */]: handleCheckMerge,
    ["CHECK_CI" /* TaskState.CHECK_CI */]: handleCheckCi,
    ["CHECK_REVIEWS" /* TaskState.CHECK_REVIEWS */]: handleCheckReviews,
    ["ALL_GREEN" /* TaskState.ALL_GREEN */]: handleAllGreen,
};
function maybeSendProgressDashboard(ctx, tasks) {
    if (!ctx.progressTarget) {
        return;
    }
    const now = Date.now();
    const stateFile = path.join(ctx.logsDir, ".progress-state.json");
    let lastSentAt = 0;
    let lastHash = "";
    if (fs.existsSync(stateFile)) {
        try {
            const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
            lastSentAt = Number(raw.lastSentAt ?? 0);
            lastHash = String(raw.hash ?? "");
        }
        catch {
            // ignore state parse issues
        }
    }
    const lines = [];
    lines.push("📊 YetiSwarm Progress");
    lines.push("");
    const ordered = [...tasks].sort((a, b) => a.started_at - b.started_at);
    if (!ordered.length) {
        lines.push("No active tasks.");
    }
    else {
        for (const task of ordered) {
            const status = task.status;
            const pr = task.pr ? `PR #${task.pr}` : "PR pending";
            lines.push(`- ${task.id} · ${task.repo_key} · ${status} · ${pr}`);
        }
    }
    const message = lines.join("\n");
    const hash = `${ordered.length}:${message}`;
    const cooldownMs = Math.max(60, ctx.progressCooldownSecs) * 1000;
    if (hash === lastHash && now - lastSentAt < cooldownMs) {
        return;
    }
    sendMessage("discord", ctx.progressTarget, ctx.progressReplyTo, message);
    fs.writeFileSync(stateFile, `${JSON.stringify({ lastSentAt: now, hash }, null, 2)}\n`, "utf8");
}
function processTask(task, ctx) {
    if (task.status === "queued") {
        // Backward-compat: queued dependency mode is deprecated; resume as normal running task.
        task.status = "running";
        task.blocked_reason = "";
        ctx.store.patchTask(task.id, { status: "running", blockedReason: "" });
    }
    let state = determineState(task);
    while (state) {
        const handler = HANDLERS[state];
        state = handler(task, ctx);
    }
}
function main() {
    setupCronEnv();
    const entryFile = process.argv[1] || import.meta.url.replace("file://", "");
    const runtime = resolveRuntimePaths(entryFile);
    const swarmDir = runtime.swarmHome;
    const reposFile = runtime.reposFile;
    const dbPath = runtime.dbPath;
    const logsDir = runtime.logsDir;
    log = setupLogging(logsDir);
    const lock = acquireMonitorLock(swarmDir);
    const now = new Date().toTimeString().slice(0, 5);
    if (!lock) {
        log.info("%s Monitor already running — skipping overlap.", now);
        return;
    }
    try {
        const store = new TaskStore(dbPath);
        const ctx = {
            swarmDir,
            reposFile,
            dbPath,
            logsDir,
            store,
            maxRetries: 3,
            maxCommentRetries: 3,
            idleTimeoutSecs: 1800,
            defaultNotifyChannel: process.env.SWARM_NOTIFY_CHANNEL || "discord",
            defaultNotifyTarget: process.env.SWARM_NOTIFY_TARGET || "",
            defaultNotifyReplyTo: process.env.SWARM_NOTIFY_REPLY_TO || "",
            progressTarget: process.env.SWARM_PROGRESS_TARGET || "",
            progressReplyTo: process.env.SWARM_PROGRESS_REPLY_TO || "",
            progressCooldownSecs: Number(process.env.SWARM_PROGRESS_COOLDOWN_SECS ?? 600),
            ghBin: "/opt/homebrew/bin/gh",
        };
        const runningCount = store.countMonitorCandidates();
        const now2 = new Date().toTimeString().slice(0, 5);
        if (runningCount === 0) {
            log.info("%s No monitor candidates.", now2);
            return;
        }
        log.info("%s Checking %d agent(s)...", now2, runningCount);
        const tasks = store.listMonitorCandidates();
        for (const task of tasks) {
            if (!task.original_prompt) {
                task.original_prompt = task.prompt;
            }
            log.info("  -> [%s/%s] checking...", task.repo_key, task.id);
            try {
                processTask(task, ctx);
            }
            catch (err) {
                log.exception(`  ERROR processing ${task.id}:`, err);
            }
        }
        maybeSendProgressDashboard(ctx, store.listMonitorCandidates());
        log.info("%s Check complete.", now2);
    }
    finally {
        releaseMonitorLock(lock);
    }
}
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}

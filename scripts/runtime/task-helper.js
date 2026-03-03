#!/usr/bin/env node
import process from "node:process";
import { TaskStore, parsePrData, parseReviews, parseCiStatus, formatPrFeedback, loadRepoConfig, listRepoKeys, taskToDict, } from "./task-store.js";
import { withConnection } from "./db.js";
import { resolveRuntimePaths } from "./runtime-paths.js";
function runtimeDefaults() {
    const entryFile = process.argv[1] || import.meta.url.replace("file://", "");
    const runtime = resolveRuntimePaths(entryFile);
    return { dbPath: runtime.dbPath, reposFile: runtime.reposFile };
}
function consumeDbPath(args) {
    const defaults = runtimeDefaults();
    if (!args.length) {
        return [defaults.dbPath, []];
    }
    return [args[0], args.slice(1)];
}
function consumeReposFile(args) {
    const defaults = runtimeDefaults();
    if (!args.length) {
        return [defaults.reposFile, []];
    }
    return [args[0], args.slice(1)];
}
function cmdListRunning(args) {
    const [dbPath] = consumeDbPath(args);
    const store = new TaskStore(dbPath);
    for (const t of store.listRunning()) {
        console.log(JSON.stringify(taskToDict(t)));
    }
}
function cmdCountRunning(args) {
    const [dbPath] = consumeDbPath(args);
    const store = new TaskStore(dbPath);
    console.log(store.countRunning());
}
function cmdGetField(args) {
    const obj = JSON.parse(args[0] || "{}");
    const field = args[1];
    const def = args.length > 3 && args[2] === "--default" ? args[3] : "";
    const val = obj[field];
    console.log(val ?? def);
}
function cmdGetFields(args) {
    const obj = JSON.parse(args[0] || "{}");
    const fields = args.slice(1);
    const vals = fields.map((f) => {
        const v = obj[f];
        return v == null ? "" : String(v);
    });
    console.log(vals.join("\x1e"));
}
function cmdParsePr(args) {
    const [num, url] = parsePrData(args[0] || "");
    if (num !== null) {
        console.log(`${num}\t${url ?? ""}`);
    }
    else {
        console.log("\t");
    }
}
function cmdParseReviews(args) {
    const [approved, changes, reviewers] = parseReviews(args[0] || "");
    console.log(`${approved}\t${changes}\t${reviewers}`);
}
function cmdParseCi(args) {
    console.log(parseCiStatus(args[0] || ""));
}
function cmdPatchTask(args) {
    const [dbPath, rest] = consumeDbPath(args);
    const store = new TaskStore(dbPath);
    store.patchTask(rest[0], JSON.parse(rest[1] || "{}"));
}
function cmdRemoveTask(args) {
    const [dbPath, rest] = consumeDbPath(args);
    const store = new TaskStore(dbPath);
    store.removeTask(rest[0]);
}
function cmdGetPrUrl(args) {
    const [dbPath, rest] = consumeDbPath(args);
    const store = new TaskStore(dbPath);
    console.log(store.getPrUrl(rest[0]));
}
function cmdRegisterTask(args) {
    const [dbPath, rest] = consumeDbPath(args);
    const store = new TaskStore(dbPath);
    store.registerTask(rest[0]);
}
function cmdRepoConfig(args) {
    const [reposFile, rest] = consumeReposFile(args);
    const config = loadRepoConfig(reposFile, rest[0]);
    if (!config) {
        process.exit(1);
    }
    console.log(`${config.path}\t${config.ghRepo}\t${config.worktrees}\t${config.ciCmd}\t${config.installCmd}`);
}
function cmdRepoKeys(args) {
    const [reposFile] = consumeReposFile(args);
    console.log(listRepoKeys(reposFile).join(", "));
}
function cmdFormatPrFeedback(args) {
    const reviewsJson = args[0] || "";
    const commentsJson = args[1] || "";
    let since = "";
    if (args.length > 3 && args[2] === "--since") {
        since = args[3] || "";
    }
    const result = formatPrFeedback(reviewsJson, commentsJson, since);
    if (result) {
        const [latestAt, feedbackText] = result;
        console.log(latestAt);
        console.log(feedbackText);
    }
}
function cmdDumpTasks(args) {
    const [dbPath] = consumeDbPath(args);
    const store = new TaskStore(dbPath);
    const tasks = store.load().map(taskToDict);
    console.log(JSON.stringify({ tasks }, null, 2));
}
function cmdDumpEvents(args) {
    const [dbPath, rest] = consumeDbPath(args);
    const limit = rest[0] ? Number(rest[0]) : 50;
    const events = withConnection(dbPath, (db) => {
        return db
            .prepare("SELECT * FROM task_events ORDER BY created_at DESC LIMIT ?")
            .all(limit);
    });
    console.log(JSON.stringify(events, null, 2));
}
const COMMANDS = {
    "list-running": cmdListRunning,
    "count-running": cmdCountRunning,
    "get-field": cmdGetField,
    "get-fields": cmdGetFields,
    "parse-pr": cmdParsePr,
    "parse-reviews": cmdParseReviews,
    "parse-ci": cmdParseCi,
    "patch-task": cmdPatchTask,
    "remove-task": cmdRemoveTask,
    "get-pr-url": cmdGetPrUrl,
    "register-task": cmdRegisterTask,
    "repo-config": cmdRepoConfig,
    "repo-keys": cmdRepoKeys,
    "format-pr-feedback": cmdFormatPrFeedback,
    "dump-tasks": cmdDumpTasks,
    "dump-events": cmdDumpEvents,
};
function main() {
    const cmd = process.argv[2];
    if (!cmd || !COMMANDS[cmd]) {
        console.error(`Usage: ${process.argv[1]} <command> [args...]`);
        console.error(`Commands: ${Object.keys(COMMANDS).join(", ")}`);
        process.exit(1);
    }
    COMMANDS[cmd](process.argv.slice(3));
}
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}

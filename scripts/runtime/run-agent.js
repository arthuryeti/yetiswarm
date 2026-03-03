#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { _run, setupCronEnv, processSpawn, processIsAlive, sleepSync, isAgentAlive, gitFetch, gitPull, gitBranchExists, gitWorktreeAddExisting, gitWorktreeAddNew, dockerComposeUp, runInstall, } from "./shell.js";
import { TaskStore, listRepoKeys, loadRepoConfig, parsePrData, upsertRepoConfig, } from "./task-store.js";
import { resolveRuntimePaths } from "./runtime-paths.js";
function cmdOutput(result) {
    const msg = (result.stderr || result.stdout || "").trim();
    return msg || "No command output.";
}
function findBranchWorktree(repoDir, branch) {
    const result = _run(["/usr/bin/git", "-C", repoDir, "worktree", "list", "--porcelain"]);
    if (result.returncode !== 0) {
        return null;
    }
    const expectedRef = `refs/heads/${branch}`;
    let currentPath = null;
    for (const rawLine of result.stdout.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.startsWith("worktree ")) {
            currentPath = line.slice("worktree ".length).trim();
            continue;
        }
        if (line.startsWith("branch ")) {
            const ref = line.slice("branch ".length).trim();
            if (ref === expectedRef || ref === branch) {
                return currentPath;
            }
        }
    }
    return null;
}
function setupWorktree(repoDir, worktreesDir, worktreePath, branch) {
    fs.mkdirSync(worktreesDir, { recursive: true });
    const fetchResult = gitFetch(repoDir);
    if (fetchResult.returncode !== 0) {
        throw new Error(`git fetch failed for repo '${repoDir}'.\n${cmdOutput(fetchResult)}`);
    }
    if (fs.existsSync(worktreePath) && fs.statSync(worktreePath).isDirectory()) {
        console.log(`Worktree exists at ${worktreePath} — pulling latest`);
        const pullResult = gitPull(worktreePath, branch);
        if (pullResult.returncode !== 0) {
            console.log(`Warning: git pull failed in existing worktree (${branch}). Continuing.\n${cmdOutput(pullResult)}`);
        }
    }
    else if (gitBranchExists(repoDir, branch)) {
        console.log(`Creating worktree from existing branch: ${branch}`);
        const addResult = gitWorktreeAddExisting(repoDir, worktreePath, branch);
        if (!(fs.existsSync(worktreePath) && fs.statSync(worktreePath).isDirectory())) {
            const existingPath = findBranchWorktree(repoDir, branch);
            if (existingPath && fs.existsSync(existingPath) && fs.statSync(existingPath).isDirectory()) {
                console.log(`Branch '${branch}' is already checked out at ${existingPath} — reusing that worktree.`);
                worktreePath = existingPath;
            }
            else {
                throw new Error(`git worktree add failed for existing branch '${branch}'.\n${cmdOutput(addResult)}`);
            }
        }
        const pullResult = gitPull(worktreePath, branch);
        if (pullResult.returncode !== 0) {
            console.log(`Warning: git pull failed in worktree (${branch}). Continuing.\n${cmdOutput(pullResult)}`);
        }
    }
    else {
        console.log(`Creating worktree with new branch: ${branch}`);
        const addResult = gitWorktreeAddNew(repoDir, worktreePath, branch);
        if (addResult.returncode !== 0 || !(fs.existsSync(worktreePath) && fs.statSync(worktreePath).isDirectory())) {
            throw new Error(`git worktree add failed for new branch '${branch}'.\n${cmdOutput(addResult)}`);
        }
    }
    if (!(fs.existsSync(worktreePath) && fs.statSync(worktreePath).isDirectory())) {
        throw new Error(`Resolved worktree path does not exist: ${worktreePath}`);
    }
    return worktreePath;
}
function copyEnv(repoDir, worktreePath) {
    if (!(fs.existsSync(worktreePath) && fs.statSync(worktreePath).isDirectory())) {
        throw new Error(`Worktree path does not exist: ${worktreePath}. Agent setup cannot continue.`);
    }
    const src = path.join(repoDir, ".env");
    const dst = path.join(worktreePath, ".env");
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
        console.log("Copied .env");
    }
}
function tailFile(filePath, maxLines = 25) {
    if (!fs.existsSync(filePath)) {
        return "Log file not found.";
    }
    try {
        const text = fs.readFileSync(filePath, "utf8");
        const lines = text.split(/\r?\n/);
        const tail = lines.slice(-maxLines).join("\n").trim();
        return tail || "No log output captured.";
    }
    catch {
        return "Unable to read log file.";
    }
}
function findExistingPr(ghRepo, branch) {
    const result = _run([
        "gh",
        "pr",
        "list",
        "--repo",
        ghRepo,
        "--head",
        branch,
        "--json",
        "number,url,state",
        "--limit",
        "1",
    ]);
    if (result.returncode !== 0) {
        return [null, null];
    }
    return parsePrData(result.stdout.trim());
}
function expandHome(inputPath) {
    if (!inputPath)
        return inputPath;
    if (inputPath.startsWith("~/")) {
        return path.join(os.homedir(), inputPath.slice(2));
    }
    if (inputPath === "~") {
        return os.homedir();
    }
    return inputPath;
}
function runOrThrow(cmd, cwd, timeout = 120) {
    const result = _run(cmd, timeout, cwd);
    if (result.returncode !== 0) {
        throw new Error(`Command failed: ${cmd.join(" ")}\n${cmdOutput(result)}`);
    }
    return result.stdout.trim();
}
function ensureCodexAvailable() {
    const check = _run(["/bin/sh", "-lc", "command -v codex >/dev/null 2>&1"]);
    if (check.returncode !== 0) {
        throw new Error("codex CLI was not found in PATH. Install codex and retry.");
    }
}
function hasGitRepo(dir) {
    return fs.existsSync(path.join(dir, ".git"));
}
function writeFileIfMissing(filePath, content) {
    if (fs.existsSync(filePath)) {
        return;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
}
function scaffoldNextJs(repoDir, repoName) {
    const packageJson = {
        name: repoName,
        version: "0.1.0",
        private: true,
        scripts: {
            dev: "next dev",
            build: "next build",
            start: "next start",
            lint: "next lint",
        },
        dependencies: {
            next: "^15.2.0",
            react: "^19.0.0",
            "react-dom": "^19.0.0",
        },
        devDependencies: {
            "@types/node": "^22.13.10",
            "@types/react": "^19.0.0",
            "@types/react-dom": "^19.0.0",
            typescript: "^5.8.2",
        },
    };
    writeFileIfMissing(path.join(repoDir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
    writeFileIfMissing(path.join(repoDir, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
            target: "ES2022",
            lib: ["dom", "dom.iterable", "esnext"],
            allowJs: false,
            skipLibCheck: true,
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            module: "esnext",
            moduleResolution: "bundler",
            resolveJsonModule: true,
            isolatedModules: true,
            jsx: "preserve",
            incremental: true,
            plugins: [{ name: "next" }],
        },
        include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
        exclude: ["node_modules"],
    }, null, 2) + "\n");
    writeFileIfMissing(path.join(repoDir, "next.config.mjs"), "const nextConfig = {};\n\nexport default nextConfig;\n");
    writeFileIfMissing(path.join(repoDir, "next-env.d.ts"), "/// <reference types=\"next\" />\n/// <reference types=\"next/image-types/global\" />\n\n// This file is auto-managed by Next.js.\n");
    writeFileIfMissing(path.join(repoDir, "app/layout.tsx"), "export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang=\"en\">\n      <body>{children}</body>\n    </html>\n  );\n}\n");
    writeFileIfMissing(path.join(repoDir, "app/page.tsx"), "export default function Page() {\n  return <main><h1>Welcome to the project</h1></main>;\n}\n");
    writeFileIfMissing(path.join(repoDir, ".gitignore"), "node_modules\n.next\n.env\n.env.local\n.DS_Store\n");
}
function scaffoldNodeCli(repoDir, repoName) {
    const packageJson = {
        name: repoName,
        version: "0.1.0",
        type: "module",
        private: true,
        bin: {
            [repoName]: "dist/index.js",
        },
        scripts: {
            build: "tsc -p tsconfig.json",
            check: "tsc -p tsconfig.json --noEmit",
            start: "node dist/index.js",
        },
        devDependencies: {
            "@types/node": "^22.13.10",
            typescript: "^5.8.2",
        },
    };
    writeFileIfMissing(path.join(repoDir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
    writeFileIfMissing(path.join(repoDir, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            outDir: "dist",
            rootDir: "src",
            esModuleInterop: true,
            skipLibCheck: true,
        },
        include: ["src/**/*.ts"],
    }, null, 2) + "\n");
    writeFileIfMissing(path.join(repoDir, "src/index.ts"), "#!/usr/bin/env node\n\nconsole.log(\"Node CLI scaffold ready.\");\n");
    writeFileIfMissing(path.join(repoDir, ".gitignore"), "node_modules\ndist\n.env\n.DS_Store\n");
}
function scaffoldBare(repoDir, repoName) {
    writeFileIfMissing(path.join(repoDir, "README.md"), `# ${repoName}\n\nInitial scaffold.\n`);
}
function scaffoldRepoTemplate(repoDir, template, repoName) {
    switch (template) {
        case "nextjs":
            scaffoldNextJs(repoDir, repoName);
            return;
        case "node-cli":
            scaffoldNodeCli(repoDir, repoName);
            return;
        case "bare":
        default:
            scaffoldBare(repoDir, repoName);
    }
}
function commitAndPushIfDirty(repoDir, message) {
    runOrThrow(["/usr/bin/git", "-C", repoDir, "add", "."], undefined, 30);
    const status = _run(["/usr/bin/git", "-C", repoDir, "status", "--porcelain"], 30);
    if (!status.stdout.trim()) {
        return;
    }
    const branchResult = _run(["/usr/bin/git", "-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"], 30);
    const branch = branchResult.returncode === 0 ? branchResult.stdout.trim() : "main";
    runOrThrow(["/usr/bin/git", "-C", repoDir, "commit", "-m", message], undefined, 45);
    runOrThrow(["/usr/bin/git", "-C", repoDir, "push", "origin", branch], undefined, 60);
}
function defaultTemplateOptions(template) {
    switch (template) {
        case "nextjs":
            return {
                ciCmd: "npm run build",
                installCmd: "npm install --silent",
                techStack: "nextjs,react,typescript",
            };
        case "node-cli":
            return {
                ciCmd: "npm run build",
                installCmd: "npm install --silent",
                techStack: "nodejs,typescript,cli",
            };
        case "bare":
        default:
            return {
                ciCmd: "echo \"No CI configured\"",
                installCmd: "true",
                techStack: "custom",
            };
    }
}
function resolveRepoSlug(repoKey, owner) {
    if (repoKey.includes("/")) {
        const [prefix, name] = repoKey.split("/", 2);
        return { repoName: name, ghRepo: `${prefix}/${name}` };
    }
    return {
        repoName: repoKey,
        ghRepo: owner ? `${owner}/${repoKey}` : repoKey,
    };
}
function ensureRepoConfig(reposFile, repoKey, options) {
    const existing = loadRepoConfig(reposFile, repoKey);
    if (existing) {
        return existing;
    }
    const siteRoot = path.resolve(expandHome(options.siteRoot || "~/Sites"));
    fs.mkdirSync(siteRoot, { recursive: true });
    const { repoName, ghRepo } = resolveRepoSlug(repoKey, options.githubOwner);
    const repoDir = path.join(siteRoot, repoName);
    const description = options.description || `Bootstrapped by YetiSwarm (${options.template})`;
    const visibilityFlag = options.visibility === "public" ? "--public" : "--private";
    if (!hasGitRepo(repoDir)) {
        const create = _run([
            "gh",
            "repo",
            "create",
            ghRepo,
            visibilityFlag,
            "--clone",
            "--add-readme",
            "--description",
            description,
        ], 120, siteRoot);
        if (create.returncode !== 0) {
            // If repo already exists remotely, clone it locally.
            runOrThrow(["gh", "repo", "clone", ghRepo, repoName], siteRoot, 120);
        }
    }
    if (!hasGitRepo(repoDir)) {
        throw new Error(`Repository bootstrap failed: missing git repo at ${repoDir}`);
    }
    scaffoldRepoTemplate(repoDir, options.template, repoName);
    commitAndPushIfDirty(repoDir, `chore: scaffold ${options.template} template`);
    const defaults = defaultTemplateOptions(options.template);
    const worktrees = path.join(siteRoot, "worktrees", repoName);
    upsertRepoConfig(reposFile, repoKey, {
        name: repoName,
        path: repoDir,
        ghRepo,
        githubUrl: `https://github.com/${ghRepo}`,
        description,
        techStack: options.techStack || defaults.techStack,
        worktrees,
        ciCmd: defaults.ciCmd,
        installCmd: defaults.installCmd,
        contextFiles: [],
        dockerCompose: false,
        promptPreamble: "",
    });
    return loadRepoConfig(reposFile, repoKey);
}
function loadSessionDeliveries(swarmDir) {
    const candidates = [
        process.env.OPENCLAW_STATE_DIR || "",
        path.resolve(swarmDir, "..", ".."),
        path.join(os.homedir(), ".openclaw"),
    ]
        .map((p) => p.trim())
        .filter(Boolean);
    for (const stateDir of candidates) {
        const sessionFile = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
        if (!fs.existsSync(sessionFile)) {
            continue;
        }
        try {
            const raw = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
            const rows = [];
            for (const [key, entry] of Object.entries(raw)) {
                if (key.includes(":cron:")) {
                    continue;
                }
                const dc = entry.deliveryContext || {};
                const channel = String(dc.channel ?? entry.lastChannel ?? entry.channel ?? "").trim();
                const to = String(dc.to ?? entry.lastTo ?? "").trim();
                const updatedAt = Number(entry.updatedAt ?? 0);
                const chatType = String(entry.chatType ?? "").trim().toLowerCase();
                if (!channel || !to || updatedAt <= 0) {
                    continue;
                }
                rows.push({ key, channel, to, updatedAt, chatType });
            }
            return rows.sort((a, b) => b.updatedAt - a.updatedAt);
        }
        catch {
            continue;
        }
    }
    return [];
}
function detectOriginNotifyContext(swarmDir) {
    const rows = loadSessionDeliveries(swarmDir);
    if (!rows.length) {
        return null;
    }
    const preferred = rows.find((r) => ["group", "channel", "thread", "topic"].includes(r.chatType)) ?? rows[0];
    return {
        channel: preferred.channel,
        target: preferred.to,
        replyTo: "",
    };
}
function resolveTaskNotifyContext(swarmDir, providedChannel, providedTarget, providedReplyTo) {
    const envChannel = (process.env.SWARM_NOTIFY_CHANNEL || "").trim();
    const envTarget = (process.env.SWARM_NOTIFY_TARGET || "").trim();
    const envReplyTo = (process.env.SWARM_NOTIFY_REPLY_TO || "").trim();
    const detected = detectOriginNotifyContext(swarmDir);
    const target = providedTarget || envTarget || detected?.target || "";
    const channel = providedChannel || envChannel || detected?.channel || "discord";
    const replyTo = providedReplyTo || envReplyTo || detected?.replyTo || "";
    return { channel, target, replyTo };
}
function parseCliOptions(extraArgs) {
    const options = {
        template: "bare",
        description: "",
        techStack: "",
        visibility: "private",
        githubOwner: "",
        siteRoot: "~/Sites",
        notifyChannel: "",
        notifyTarget: "",
        notifyReplyTo: "",
    };
    for (let i = 0; i < extraArgs.length; i++) {
        const arg = extraArgs[i];
        const next = extraArgs[i + 1];
        switch (arg) {
            case "--template":
                if (next && ["nextjs", "node-cli", "bare"].includes(next)) {
                    options.template = next;
                    i++;
                }
                break;
            case "--description":
                if (next) {
                    options.description = next;
                    i++;
                }
                break;
            case "--tech-stack":
                if (next) {
                    options.techStack = next;
                    i++;
                }
                break;
            case "--visibility":
                if (next === "public" || next === "private") {
                    options.visibility = next;
                    i++;
                }
                break;
            case "--github-owner":
                if (next) {
                    options.githubOwner = next;
                    i++;
                }
                break;
            case "--site-root":
                if (next) {
                    options.siteRoot = next;
                    i++;
                }
                break;
            case "--notify-channel":
                if (next) {
                    options.notifyChannel = next.trim();
                    i++;
                }
                break;
            case "--notify-target":
                if (next) {
                    options.notifyTarget = next.trim();
                    i++;
                }
                break;
            case "--notify-reply-to":
                if (next) {
                    options.notifyReplyTo = next.trim();
                    i++;
                }
                break;
            default:
                break;
        }
    }
    return options;
}
export function spawnAgent(args) {
    const { repoKey, taskId, branch, agent, model, thinking, prompt, template = "bare", description = "", techStack = "", visibility = "private", githubOwner = "", siteRoot = "~/Sites", notifyChannel = "", notifyTarget = "", notifyReplyTo = "", } = args;
    const entryFile = process.argv[1] || import.meta.url.replace("file://", "");
    const runtime = resolveRuntimePaths(entryFile);
    const swarmDir = args.swarmDir ?? runtime.swarmHome;
    const reposFile = args.reposFile ?? runtime.reposFile;
    const dbPath = args.dbPath ?? runtime.dbPath;
    const logsDir = args.logsDir ?? runtime.logsDir;
    const config = loadRepoConfig(reposFile, repoKey) ??
        ensureRepoConfig(reposFile, repoKey, {
            template,
            description,
            techStack,
            visibility,
            githubOwner,
            siteRoot,
            notifyChannel,
            notifyTarget,
            notifyReplyTo,
        });
    if (!config) {
        console.log(`Unable to resolve or create repo key: ${repoKey}.`);
        process.exit(1);
    }
    const repoDir = config.path;
    const ghRepo = config.ghRepo;
    const worktreesDir = config.worktrees;
    const ciCmd = config.ciCmd;
    const installCmd = config.installCmd;
    const dockerCompose = config.dockerCompose;
    const promptPreamble = config.promptPreamble;
    let worktreePath = path.join(worktreesDir, taskId);
    const logFile = path.join(logsDir, `${taskId}.log`);
    const store = new TaskStore(dbPath);
    const notify = resolveTaskNotifyContext(swarmDir, notifyChannel, notifyTarget, notifyReplyTo);
    const existing = store.getTask(taskId);
    if (existing && isAgentAlive(existing)) {
        console.log(`Agent '${taskId}' is already running (PID ${existing.pid}). Kill it first.`);
        process.exit(1);
    }
    for (const task of store.listRunning()) {
        if (task.id !== taskId &&
            task.repo_key === repoKey &&
            task.branch === branch &&
            isAgentAlive(task)) {
            console.log(`Branch '${branch}' already has an active agent task '${task.id}' (PID ${task.pid}). Stop or reuse that task first.`);
            process.exit(1);
        }
    }
    let prInstructions = `\n\nWhen the implementation is complete:\n` +
        `1. Run: ${ciCmd}\n` +
        `2. Fix any errors before proceeding\n` +
        `3. Commit all changes with a clear commit message\n` +
        `4. Push the branch: git push origin ${branch}\n` +
        `5. Open a PR: gh pr create --fill --repo ${ghRepo}\n` +
        `6. PR description must include: what changed, why, and screenshots if any UI changed`;
    if (promptPreamble) {
        prInstructions = `\n${promptPreamble}${prInstructions}`;
    }
    const fullPrompt = `${prompt}${prInstructions}`;
    const [existingPr, existingPrUrl] = findExistingPr(ghRepo, branch);
    if (existingPr !== null) {
        console.log(`Found existing PR #${existingPr} for branch ${branch}`);
    }
    const startedAt = Date.now();
    const taskJson = JSON.stringify({
        id: taskId,
        repoKey,
        repoDir,
        ghRepo,
        tmuxSession: "",
        agent,
        model,
        thinking,
        branch,
        worktree: worktreePath,
        startedAt,
        status: "running",
        retries: 0,
        pr: existingPr,
        prUrl: existingPrUrl,
        originalPrompt: prompt,
        prompt: fullPrompt,
        notifyOnComplete: true,
        notifyChannel: notify.channel,
        notifyTarget: notify.target,
        notifyReplyTo: notify.replyTo,
        checks: {},
        pid: null,
    });
    store.registerTask(taskJson);
    if (!notify.target) {
        console.log("Warning: notification target is empty; monitor updates will not be delivered.");
        console.log("Provide --notify-target or set SWARM_NOTIFY_TARGET to force a destination.");
    }
    let pid = 0;
    try {
        const resolvedWorktree = setupWorktree(repoDir, worktreesDir, worktreePath, branch);
        if (resolvedWorktree !== worktreePath) {
            worktreePath = resolvedWorktree;
            store.patchTask(taskId, { worktree: worktreePath });
        }
        copyEnv(repoDir, worktreePath);
        console.log("Installing dependencies...");
        const installResult = runInstall(worktreePath, installCmd);
        if (installResult.returncode !== 0) {
            let installErr = (installResult.stderr || installResult.stdout || "").trim();
            if (installErr.length > 1200) {
                installErr = installErr.slice(-1200);
            }
            throw new Error(`Dependency install failed (exit ${installResult.returncode}) for '${installCmd}'.\n${installErr || "No command output available."}`);
        }
        if (dockerCompose) {
            console.log("Ensuring Docker DB is up...");
            dockerComposeUp(repoDir);
        }
        const promptFile = path.join(worktreePath, ".agent-prompt.txt");
        fs.writeFileSync(promptFile, fullPrompt, "utf8");
        fs.mkdirSync(logsDir, { recursive: true });
        console.log(`Spawning ${agent} agent as background process...`);
        ensureCodexAvailable();
        pid = processSpawn("codex", [
            "exec",
            "--model",
            model,
            "-c",
            `model_reasoning_effort=${thinking}`,
            "--dangerously-bypass-approvals-and-sandbox",
            "-",
        ], worktreePath, logFile, { stdinFile: promptFile });
        if (!Number.isInteger(pid) || pid <= 0) {
            throw new Error("Failed to launch codex agent: invalid PID returned from process spawn.");
        }
        store.patchTask(taskId, { pid });
        sleepSync(1000);
        if (!processIsAlive(pid)) {
            throw new Error(`Agent process exited immediately after spawn.\nLast log output:\n${tailFile(logFile)}`);
        }
    }
    catch (err) {
        store.patchTask(taskId, {
            checks: { spawnError: String(err instanceof Error ? err.message : err) },
            pid: null,
        });
        throw err;
    }
    console.log("");
    console.log("Agent launched");
    console.log(`   Repo     : ${repoKey} (${ghRepo})`);
    console.log(`   Task ID  : ${taskId}`);
    console.log(`   Branch   : ${branch}`);
    console.log(`   Agent    : ${agent} (${model} · thinking: ${thinking})`);
    console.log(`   Worktree : ${worktreePath}`);
    console.log(`   Notify   : ${notify.channel} ${notify.target || "(none)"}`);
    console.log(`   PID      : ${pid}`);
    console.log(`   Log      : ${logFile}`);
    console.log(`   Watch    : tail -f ${logFile}`);
}
function main() {
    setupCronEnv();
    const entryFile = process.argv[1] || import.meta.url.replace("file://", "");
    const runtime = resolveRuntimePaths(entryFile);
    if (process.argv.length < 9) {
        const keys = fs.existsSync(runtime.reposFile) ? listRepoKeys(runtime.reposFile).join(", ") : "?";
        console.log(`Usage: ${process.argv[1]} <repo-key> <task-id> <branch> <agent> <model> <thinking> \"<prompt>\"`);
        console.log("Optional flags: --template <nextjs|node-cli|bare> --description <text> --tech-stack <csv> --visibility <private|public> --github-owner <owner> --site-root <path> --notify-channel <channel> --notify-target <target> --notify-reply-to <message-id>");
        console.log(`Repos: ${keys}`);
        process.exit(1);
    }
    const options = parseCliOptions(process.argv.slice(9));
    spawnAgent({
        repoKey: process.argv[2],
        taskId: process.argv[3],
        branch: process.argv[4],
        agent: process.argv[5],
        model: process.argv[6],
        thinking: process.argv[7],
        prompt: process.argv[8],
        template: options.template,
        description: options.description,
        techStack: options.techStack,
        visibility: options.visibility,
        githubOwner: options.githubOwner,
        siteRoot: options.siteRoot,
        notifyChannel: options.notifyChannel,
        notifyTarget: options.notifyTarget,
        notifyReplyTo: options.notifyReplyTo,
        swarmDir: runtime.swarmHome,
        reposFile: runtime.reposFile,
        dbPath: runtime.dbPath,
        logsDir: runtime.logsDir,
    });
}
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
export function _run(cmd, timeout = 30, cwd) {
    try {
        const result = spawnSync(cmd[0], cmd.slice(1), {
            cwd,
            encoding: "utf8",
            timeout: timeout * 1000,
            stdio: ["ignore", "pipe", "pipe"],
        });
        if (result.error) {
            return {
                returncode: 1,
                stdout: result.stdout ?? "",
                stderr: result.stderr ?? "",
            };
        }
        return {
            returncode: result.status ?? 1,
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
        };
    }
    catch {
        return { returncode: 1, stdout: "", stderr: "" };
    }
}
export function sleepSync(ms) {
    if (ms <= 0)
        return;
    const a = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(a, 0, 0, ms);
}
export function setupCronEnv() {
    const home = os.homedir();
    const existingParts = (process.env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean);
    const preferredParts = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        path.join(home, ".local", "bin"),
    ];
    const pnpmDir = path.join(home, "Library", "pnpm");
    preferredParts.push(pnpmDir);
    const pnpmNodeRoot = path.join(pnpmDir, "nodejs");
    if (fs.existsSync(pnpmNodeRoot) && fs.statSync(pnpmNodeRoot).isDirectory()) {
        for (const entry of fs.readdirSync(pnpmNodeRoot).sort().reverse()) {
            const candidate = path.join(pnpmNodeRoot, entry, "bin");
            if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
                preferredParts.push(candidate);
            }
        }
    }
    const merged = [];
    for (const p of [...preferredParts, ...existingParts]) {
        if (p && !merged.includes(p)) {
            merged.push(p);
        }
    }
    process.env.PATH = merged.join(path.delimiter);
    const ghTokenFile = path.join(home, ".config", "gh", "gh_token.txt");
    if (fs.existsSync(ghTokenFile)) {
        process.env.GH_TOKEN = fs.readFileSync(ghTokenFile, "utf8").trim();
    }
}
export function tmuxHasSession(session) {
    return _run(["tmux", "has-session", "-t", session]).returncode === 0;
}
export function tmuxKillSession(session) {
    _run(["tmux", "kill-session", "-t", session]);
}
export function tmuxNewSession(session, cwd) {
    _run(["tmux", "new-session", "-d", "-s", session, "-c", cwd]);
}
function quoteSingleForShell(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
export function tmuxPipePane(session, logFile) {
    _run(["tmux", "pipe-pane", "-t", session, `cat >> ${quoteSingleForShell(logFile)}`]);
}
export function tmuxSendKeys(session, cmd) {
    _run(["tmux", "send-keys", "-t", session, cmd, "Enter"]);
}
export function gitFetch(repoDir) {
    return _run(["/usr/bin/git", "-C", repoDir, "fetch", "origin"], 60);
}
export function gitPull(cwd, branch) {
    return _run(["/usr/bin/git", "pull", "origin", branch], 30, cwd);
}
export function gitBranchExists(repoDir, branch) {
    const result = _run([
        "/usr/bin/git",
        "-C",
        repoDir,
        "branch",
        "-a",
        "--list",
        branch,
        `origin/${branch}`,
    ]);
    return Boolean(result.stdout.trim());
}
export function gitWorktreeAddExisting(repoDir, wtPath, branch) {
    return _run(["/usr/bin/git", "-C", repoDir, "worktree", "add", wtPath, branch]);
}
export function gitWorktreeAddNew(repoDir, wtPath, branch, base = "origin/main") {
    return _run(["/usr/bin/git", "-C", repoDir, "worktree", "add", wtPath, "-b", branch, base]);
}
export function gitWorktreeRemove(repoDir, worktree) {
    const result = _run(["/usr/bin/git", "-C", repoDir, "worktree", "remove", "--force", worktree]);
    if (result.returncode === 0) {
        return true;
    }
    if (fs.existsSync(worktree) && fs.statSync(worktree).isDirectory()) {
        const trash = _run(["/bin/sh", "-lc", "command -v trash || command -v trash-put"]);
        const trashBin = trash.stdout.trim();
        if (trashBin) {
            const moved = _run([trashBin, worktree]);
            if (moved.returncode === 0) {
                return true;
            }
        }
    }
    return false;
}
export function gitWorktreePrune(repoDir) {
    _run(["/usr/bin/git", "-C", repoDir, "worktree", "prune"]);
}
export function gitBranchDelete(repoDir, branch, force = false) {
    if (!branch)
        return false;
    if (branch.startsWith("refs/heads/")) {
        branch = branch.slice("refs/heads/".length);
    }
    if (["main", "master", "develop", "dev"].includes(branch)) {
        return false;
    }
    const flag = force ? "-D" : "-d";
    const result = _run(["/usr/bin/git", "-C", repoDir, "branch", flag, branch]);
    return result.returncode === 0;
}
export function gitRemoteBranchDelete(repoDir, branch, remote = "origin") {
    if (!branch)
        return false;
    if (["main", "master", "develop", "dev"].includes(branch))
        return false;
    const result = _run(["/usr/bin/git", "-C", repoDir, "push", remote, "--delete", branch], 30);
    return result.returncode === 0;
}
export function gitRemotePrune(repoDir, remote = "origin") {
    _run(["/usr/bin/git", "-C", repoDir, "remote", "prune", remote], 30);
}
export function dockerComposeUp(cwd) {
    _run(["docker", "compose", "up", "-d"], 60, cwd);
}
export function runInstall(cwd, installCmd) {
    try {
        const result = spawnSync("/bin/sh", ["-lc", installCmd], {
            cwd,
            encoding: "utf8",
            timeout: 120000,
            stdio: ["ignore", "pipe", "pipe"],
        });
        if (result.error) {
            return {
                returncode: 1,
                stdout: result.stdout ?? "",
                stderr: result.stderr ?? String(result.error),
            };
        }
        return {
            returncode: result.status ?? 1,
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
        };
    }
    catch (err) {
        return { returncode: 1, stdout: "", stderr: String(err) };
    }
}
export function processSpawn(command, args, cwd, logFile, options) {
    const mergedEnv = { ...process.env, ...(options?.env ?? {}) };
    const outFd = fs.openSync(logFile, "a");
    let inFd;
    try {
        if (options?.stdinFile) {
            inFd = fs.openSync(options.stdinFile, "r");
        }
        const child = spawn(command, args, {
            cwd,
            detached: true,
            stdio: [inFd ?? "ignore", outFd, outFd],
            env: mergedEnv,
        });
        child.once("error", (err) => {
            try {
                fs.appendFileSync(logFile, `\n[spawn-error] ${String(err)}\n`, "utf8");
            }
            catch {
                // noop
            }
        });
        const pid = child.pid ?? 0;
        child.unref();
        if (!Number.isInteger(pid) || pid <= 0) {
            throw new Error(`Failed to spawn '${command}'. Check that it is installed and available in PATH.`);
        }
        return pid;
    }
    finally {
        if (inFd !== undefined) {
            fs.closeSync(inFd);
        }
        fs.closeSync(outFd);
    }
}
export function processIsAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
export function processKill(pid, timeout = 10) {
    try {
        process.kill(pid, "SIGTERM");
    }
    catch {
        return;
    }
    const deadline = Date.now() + timeout * 1000;
    while (Date.now() < deadline) {
        if (!processIsAlive(pid)) {
            return;
        }
        sleepSync(500);
    }
    try {
        process.kill(pid, "SIGKILL");
    }
    catch {
        // noop
    }
}
export function isAgentAlive(task) {
    if (task.pid && task.pid > 0) {
        return processIsAlive(task.pid);
    }
    if (task.tmux_session) {
        return tmuxHasSession(task.tmux_session);
    }
    return false;
}
export function killAgent(task) {
    if (task.pid && task.pid > 0) {
        processKill(task.pid);
    }
    if (task.tmux_session) {
        tmuxKillSession(task.tmux_session);
    }
}

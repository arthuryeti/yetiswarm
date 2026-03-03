#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  _run,
  setupCronEnv,
  killAgent,
  gitWorktreeRemove,
  gitWorktreePrune,
  gitBranchDelete,
  gitRemoteBranchDelete,
  gitRemotePrune,
} from "./shell.js";
import { TaskStore, listRepoKeys, loadRepoConfig } from "./task-store.js";
import { resolveRuntimePaths } from "./runtime-paths.js";

function ghPrState(ghBin: string, ghRepo: string, prNumber: number): string {
  if (!ghRepo || !prNumber) {
    return "";
  }

  const result = _run([
    ghBin,
    "pr",
    "view",
    String(prNumber),
    "--repo",
    ghRepo,
    "--json",
    "state",
    "-q",
    ".state",
  ]);

  return result.returncode === 0 ? result.stdout.trim() : "";
}

function branchHasMergedPr(ghBin: string, ghRepo: string, branch: string): boolean {
  if (!ghRepo || !branch) {
    return false;
  }

  const result = _run([
    ghBin,
    "pr",
    "list",
    "--repo",
    ghRepo,
    "--head",
    branch,
    "--state",
    "all",
    "--json",
    "state,mergedAt",
    "--limit",
    "20",
  ]);

  if (result.returncode !== 0) {
    return false;
  }

  try {
    const data = JSON.parse(result.stdout || "[]") as Array<Record<string, unknown>>;
    return data.some((pr) => pr.state === "MERGED" || Boolean(pr.mergedAt));
  } catch {
    return false;
  }
}

function listLocalBranches(repoDir: string): string[] {
  const result = _run([
    "/usr/bin/git",
    "-C",
    repoDir,
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ]);
  if (result.returncode !== 0) {
    return [];
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function currentBranch(repoDir: string): string {
  const result = _run(["/usr/bin/git", "-C", repoDir, "branch", "--show-current"]);
  if (result.returncode !== 0) {
    return "";
  }
  return result.stdout.trim();
}

export function cleanup(dbPath?: string, reposFile?: string): number {
  const entryFile = process.argv[1] || import.meta.url.replace("file://", "");
  const runtime = resolveRuntimePaths(entryFile);
  const swarmDir = runtime.swarmHome;

  if (!dbPath) {
    dbPath = runtime.dbPath;
  }
  if (!reposFile) {
    reposFile = runtime.reposFile;
  }

  const ghBin = fs.existsSync("/opt/homebrew/bin/gh") ? "/opt/homebrew/bin/gh" : "gh";
  const store = new TaskStore(dbPath);
  const tasks = store.load();

  let cleaned = 0;
  const cleanedIds = new Set<string>();
  const finished = tasks.filter((t) => t.status === "done" || t.status === "failed");

  if (finished.length) {
    console.log("Cleaning up finished tasks...");

    for (const task of finished) {
      let prState = "";
      if (task.pr && task.gh_repo) {
        prState = ghPrState(ghBin, task.gh_repo, task.pr);
      }

      if (task.status === "done" && task.pr && prState !== "MERGED") {
        const stateLabel = prState || "unknown";
        console.log(`  Skipping ${task.id}: PR #${task.pr} is ${stateLabel} (not merged)`);
        continue;
      }

      if (task.status === "done" && task.pr && prState === "MERGED") {
        store.addEvent(task.id, "merged", `PR #${task.pr} merged`);
      }

      killAgent(task);
      console.log(`  Killed agent: ${task.id}`);

      if (task.worktree && fs.existsSync(task.worktree) && task.repo_dir) {
        const removed = gitWorktreeRemove(task.repo_dir, task.worktree);
        if (removed) {
          console.log(`  Removed worktree: ${task.worktree}`);
        } else {
          console.log(`  Failed to remove worktree: ${task.worktree}`);
        }
      }

      if (task.repo_dir && task.branch && prState === "MERGED") {
        const deleted = gitBranchDelete(task.repo_dir, task.branch, true);
        if (deleted) {
          console.log(`  Deleted local branch: ${task.branch}`);
        }
        const remoteDeleted = gitRemoteBranchDelete(task.repo_dir, task.branch);
        if (remoteDeleted) {
          console.log(`  Deleted remote branch: ${task.branch}`);
        }
      }

      cleaned += 1;
      cleanedIds.add(task.id);
    }
  } else {
    console.log("No finished tasks in registry.");
  }

  console.log("Pruning stale worktree refs and remote tracking branches...");
  for (const key of listRepoKeys(reposFile)) {
    const config = loadRepoConfig(reposFile, key);
    if (config) {
      gitWorktreePrune(config.path);
      gitRemotePrune(config.path);
    }
  }

  console.log("Sweeping merged local branches/worktrees...");
  const protectedBranches = new Set(["main", "master", "develop", "dev"]);
  const activeWorktrees = new Set(tasks.map((t) => t.worktree).filter(Boolean));
  let mergedSwept = 0;

  for (const key of listRepoKeys(reposFile)) {
    const config = loadRepoConfig(reposFile, key);
    if (!config) {
      continue;
    }

    const repoDir = config.path;
    const ghRepo = config.ghRepo;
    const worktreesRoot = config.worktrees || "";
    const mergedCache: Record<string, boolean> = {};

    const isMergedBranch = (branch: string): boolean => {
      if (!(branch in mergedCache)) {
        mergedCache[branch] = branchHasMergedPr(ghBin, ghRepo, branch);
      }
      return mergedCache[branch];
    };

    if (worktreesRoot && fs.existsSync(worktreesRoot) && fs.statSync(worktreesRoot).isDirectory()) {
      for (const entry of fs.readdirSync(worktreesRoot)) {
        const worktreePath = path.join(worktreesRoot, entry);
        if (!(fs.existsSync(worktreePath) && fs.statSync(worktreePath).isDirectory())) {
          continue;
        }
        if (activeWorktrees.has(worktreePath)) {
          continue;
        }

        const branch = currentBranch(worktreePath);
        if (!branch || protectedBranches.has(branch)) {
          continue;
        }

        if (isMergedBranch(branch)) {
          const removed = gitWorktreeRemove(repoDir, worktreePath);
          if (removed) {
            console.log(`  Removed merged orphan worktree: ${worktreePath}`);
            mergedSwept += 1;
          }

          const deleted = gitBranchDelete(repoDir, branch, true);
          if (deleted) {
            console.log(`  Deleted merged orphan local branch: ${branch}`);
          }
          const remoteDeleted = gitRemoteBranchDelete(repoDir, branch);
          if (remoteDeleted) {
            console.log(`  Deleted merged orphan remote branch: ${branch}`);
          }
        }
      }
    }

    for (const branch of listLocalBranches(repoDir)) {
      if (protectedBranches.has(branch)) {
        continue;
      }
      if (isMergedBranch(branch)) {
        const deleted = gitBranchDelete(repoDir, branch, true);
        if (deleted) {
          console.log(`  Deleted merged local branch: ${branch}`);
          mergedSwept += 1;
        }
        const remoteDeleted = gitRemoteBranchDelete(repoDir, branch);
        if (remoteDeleted) {
          console.log(`  Deleted merged remote branch: ${branch}`);
        }
      }
    }
  }

  const remaining = tasks.filter((t) => !cleanedIds.has(t.id));
  store.save(remaining);

  console.log(`Cleaned ${cleaned} task(s); swept ${mergedSwept} merged leftover artifact(s).`);
  return cleaned + mergedSwept;
}

function main(): void {
  setupCronEnv();
  cleanup();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

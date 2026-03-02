import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export interface SwarmRuntimePaths {
  swarmHome: string;
  reposFile: string;
  dbPath: string;
  logsDir: string;
}

function expandHome(inputPath: string): string {
  if (!inputPath) {
    return inputPath;
  }
  if (inputPath === "~") {
    return os.homedir();
  }
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function resolveInputPath(inputPath: string, baseDir: string): string {
  const expanded = expandHome(inputPath.trim());
  if (!expanded) {
    return expanded;
  }
  if (path.isAbsolute(expanded)) {
    return path.normalize(expanded);
  }
  return path.resolve(baseDir, expanded);
}

function hasSwarmMarkers(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "repos.json")) ||
    fs.existsSync(path.join(dir, "repos.example.json")) ||
    fs.existsSync(path.join(dir, "swarm.db"))
  );
}

function resolveLegacySwarmDir(entryFile: string): string {
  const cwd = process.cwd();
  if (hasSwarmMarkers(cwd)) {
    return cwd;
  }

  const dir = path.dirname(path.resolve(entryFile));
  if (hasSwarmMarkers(dir)) {
    return dir;
  }

  const parent = path.dirname(dir);
  if (hasSwarmMarkers(parent)) {
    return parent;
  }

  return dir;
}

function resolveDefaultSwarmHome(entryFile: string): string {
  const cwd = path.resolve(process.cwd());
  if (hasSwarmMarkers(cwd)) {
    return cwd;
  }
  return resolveLegacySwarmDir(entryFile);
}

export function resolveRuntimePaths(entryFile: string): SwarmRuntimePaths {
  const envHome = (process.env.SWARM_HOME || "").trim();
  const envReposFile = (process.env.SWARM_REPOS_FILE || "").trim();
  const envDbPath = (process.env.SWARM_DB_PATH || "").trim();
  const envLogsDir = (process.env.SWARM_LOGS_DIR || "").trim();

  const swarmHome = envHome ? resolveInputPath(envHome, process.cwd()) : resolveDefaultSwarmHome(entryFile);

  const reposFile = envReposFile ? resolveInputPath(envReposFile, swarmHome) : path.join(swarmHome, "repos.json");
  const dbPath = envDbPath ? resolveInputPath(envDbPath, swarmHome) : path.join(swarmHome, "swarm.db");
  const logsDir = envLogsDir ? resolveInputPath(envLogsDir, swarmHome) : path.join(swarmHome, "logs");

  return { swarmHome, reposFile, dbPath, logsDir };
}

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export type RemoteRuntimeFailureStage =
  | "remote_runtime_unconfigured"
  | "remote_connection_failed"
  | "remote_setup_failed"
  | "remote_runner_launch_failed"
  | "remote_sync_failed";

export interface RemoteRuntimeConfig {
  sshTarget: string;
  remoteRepo: string;
  sshOptions: string[];
}

export interface RemoteCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function truthyEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function remoteRuntimeMode(): "off" | "ssh" | "stub" {
  const raw = process.env.CONTACT_DEPARTURE_REMOTE_RUNTIME?.trim().toLowerCase();
  if (!raw || raw === "0" || raw === "false" || raw === "off" || raw === "no") {
    return "off";
  }
  if (raw === "stub" || raw === "local-stub") {
    return "stub";
  }
  return "ssh";
}

export function shouldDispatchPx4ReplayRemotely(): boolean {
  return remoteRuntimeMode() !== "off";
}

export function loadRemoteRuntimeConfig(): RemoteRuntimeConfig | null {
  const mode = remoteRuntimeMode();
  if (mode === "off") {
    return null;
  }
  if (mode === "stub") {
    return {
      sshTarget: "stub@remote-runtime.local",
      remoteRepo: "/workspace/Airbus-FYI",
      sshOptions: [],
    };
  }

  const sshTarget = process.env.CONTACT_DEPARTURE_REMOTE_SSH?.trim();
  const remoteRepo = process.env.CONTACT_DEPARTURE_REMOTE_REPO?.trim();
  if (!sshTarget || !remoteRepo) {
    return null;
  }

  const sshOptions = process.env.CONTACT_DEPARTURE_REMOTE_SSH_OPTS?.trim()
    ? process.env.CONTACT_DEPARTURE_REMOTE_SSH_OPTS.trim().split(/\s+/).filter(Boolean)
    : ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];

  return { sshTarget, remoteRepo, sshOptions };
}

function toPosixPath(pathName: string): string {
  return pathName.split("\\").join("/");
}

function remoteRunDir(config: RemoteRuntimeConfig, jobId: string): string {
  return `${config.remoteRepo.replace(/\/+$/, "")}/runs/${jobId}`;
}

export function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RemoteCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

export async function runSshCommand(
  config: RemoteRuntimeConfig,
  remoteCommand: string,
): Promise<RemoteCommandResult> {
  return runProcess("ssh", [...config.sshOptions, config.sshTarget, remoteCommand]);
}

export async function testRemoteConnection(config: RemoteRuntimeConfig): Promise<RemoteCommandResult> {
  return runSshCommand(config, "echo contact-departure-remote-runtime-ok");
}

export async function rsyncToRemote(
  config: RemoteRuntimeConfig,
  localPath: string,
  remotePath: string,
): Promise<RemoteCommandResult> {
  const destination = `${config.sshTarget}:${remotePath}`;
  const extra = process.env.CONTACT_DEPARTURE_REMOTE_RSYNC_OPTS?.trim().split(/\s+/).filter(Boolean) ?? [];
  return runProcess("rsync", ["-az", "--delete", ...extra, `${localPath}/`, destination]);
}

export async function rsyncFromRemote(
  config: RemoteRuntimeConfig,
  remotePath: string,
  localPath: string,
  options: { paths?: string[] } = {},
): Promise<RemoteCommandResult> {
  const source = `${config.sshTarget}:${remotePath}${options.paths?.length ? "" : "/"}`;
  const extra = process.env.CONTACT_DEPARTURE_REMOTE_RSYNC_OPTS?.trim().split(/\s+/).filter(Boolean) ?? [];
  const args = ["-az", ...extra];
  if (options.paths?.length) {
    args.push("--relative");
    for (const entry of options.paths) {
      args.push(`${config.sshTarget}:${remotePath.replace(/\/+$/, "")}/./${entry.replace(/\\/g, "/")}`);
    }
    args.push(localPath.endsWith("/") ? localPath : `${localPath}/`);
  } else {
    args.push(source, localPath.endsWith("/") ? localPath : `${localPath}/`);
  }
  return runProcess("rsync", args);
}

export async function syncJobFolderToRemote(
  config: RemoteRuntimeConfig,
  jobId: string,
  localRunDirAbs: string,
): Promise<RemoteCommandResult> {
  const remoteDir = remoteRunDir(config, jobId);
  const ensureDir = await runSshCommand(config, `mkdir -p ${JSON.stringify(remoteDir)}/artifacts`);
  if (ensureDir.exitCode !== 0) {
    return ensureDir;
  }
  return rsyncToRemote(config, localRunDirAbs, remoteDir);
}

export async function readRemoteJsonFile<T>(
  config: RemoteRuntimeConfig,
  remoteFilePath: string,
): Promise<T | null> {
  const result = await runSshCommand(config, `cat ${JSON.stringify(remoteFilePath)}`);
  if (result.exitCode !== 0) {
    return null;
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    return null;
  }
}

export async function launchRemotePx4RuntimeReplayRunner(
  config: RemoteRuntimeConfig,
  jobId: string,
): Promise<{ exitCode: number; remotePid?: number; message: string }> {
  const remoteDir = remoteRunDir(config, jobId);
  const launchCommand = [
    `cd ${JSON.stringify(config.remoteRepo)}`,
    "&&",
    "nohup",
    process.env.CONTACT_DEPARTURE_REMOTE_NODE?.trim() || "node",
    "--import",
    "tsx",
    "src/runners/px4-runtime-replay-runner.ts",
    JSON.stringify(jobId),
    ">/dev/null",
    "2>&1",
    "< /dev/null & echo $!",
  ].join(" ");
  const result = await runSshCommand(config, launchCommand);
  if (result.exitCode !== 0) {
    return {
      exitCode: result.exitCode,
      message: result.stderr.trim() || result.stdout.trim() || "Remote runner launch failed.",
    };
  }
  const remotePid = Number.parseInt(result.stdout.trim().split("\n").pop() ?? "", 10);
  if (!Number.isInteger(remotePid) || remotePid <= 0) {
    return {
      exitCode: 1,
      message: `Remote runner launch did not return a pid (remote_dir=${remoteDir}).`,
    };
  }
  return { exitCode: 0, remotePid, message: `Remote PX4 runtime replay runner launched (pid ${remotePid}).` };
}

export async function signalRemoteProcess(
  config: RemoteRuntimeConfig,
  remotePid: number,
  signal: "TERM" | "KILL" = "TERM",
): Promise<RemoteCommandResult> {
  return runSshCommand(config, `kill -${signal} ${remotePid}`);
}

export async function syncRemoteJobStateToLocal(
  config: RemoteRuntimeConfig,
  jobId: string,
  localRunDirAbs: string,
): Promise<{ synced: boolean; message?: string }> {
  const remoteDir = remoteRunDir(config, jobId);
  const result = await rsyncFromRemote(config, remoteDir, localRunDirAbs, {
    paths: ["status.json", "events.jsonl", "result.json", "job.json"],
  });
  if (result.exitCode !== 0) {
    return {
      synced: false,
      message: result.stderr.trim() || result.stdout.trim() || "Remote state sync failed.",
    };
  }
  return { synced: true };
}

export async function syncRemoteArtifactsToLocal(
  config: RemoteRuntimeConfig,
  jobId: string,
  localRunDirAbs: string,
  artifactPaths: string[],
): Promise<{ synced: boolean; message?: string }> {
  const remoteDir = remoteRunDir(config, jobId);
  const bounded = [...new Set(artifactPaths.map((entry) => entry.trim()).filter(Boolean))].slice(0, 32);
  if (bounded.length === 0) {
    return { synced: true };
  }

  const relativePaths: string[] = [];
  for (const entry of bounded) {
    const normalized = entry.replace(/^\.?\//, "").replace(/\\/g, "/");
    const prefix = `runs/${jobId}/`;
    const relativePath = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
    if (
      isAbsolute(entry) ||
      relativePath.startsWith("/") ||
      relativePath.includes("..") ||
      !relativePath.startsWith("artifacts/") ||
      relativePath === "artifacts/"
    ) {
      return {
        synced: false,
        message: `Remote artifact path is outside the bounded job artifact directory: ${entry}`,
      };
    }
    relativePaths.push(relativePath);
  }

  const result = await rsyncFromRemote(config, remoteDir, localRunDirAbs, { paths: relativePaths });
  if (result.exitCode !== 0) {
    return {
      synced: false,
      message: result.stderr.trim() || result.stdout.trim() || "Remote artifact sync failed.",
    };
  }
  return { synced: true };
}

export async function writeRemoteFailureArtifact(
  artifactDirAbs: string,
  stage: RemoteRuntimeFailureStage,
  message: string,
  config?: RemoteRuntimeConfig | null,
): Promise<void> {
  await mkdir(artifactDirAbs, { recursive: true });
  const payload = {
    stage,
    message,
    ssh_target: config?.sshTarget,
    remote_repo: config?.remoteRepo,
    recorded_at: new Date().toISOString(),
  };
  await writeFile(join(artifactDirAbs, "remote-runtime-failure.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await writeFile(
    join(artifactDirAbs, "remote-runtime-failure.md"),
    [
      "# Remote runtime failure",
      "",
      `- **Stage:** ${stage}`,
      `- **Message:** ${message}`,
      config?.sshTarget ? `- **SSH target:** ${config.sshTarget}` : "",
      config?.remoteRepo ? `- **Remote repo:** ${config.remoteRepo}` : "",
      "",
      "This is an infrastructure/setup observation for the remote evidence runtime, not firmware safety proof.",
    ]
      .filter(Boolean)
      .join("\n"),
    "utf8",
  );
}

export async function appendLocalEvent(
  eventsPath: string,
  event: Record<string, unknown>,
): Promise<void> {
  await mkdir(dirname(eventsPath), { recursive: true });
  await appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
}

export function localRunDirForJob(jobId: string): string {
  return join(REPO_ROOT, "runs", jobId);
}

export function relativeRepoPath(absPath: string): string {
  return toPosixPath(relative(REPO_ROOT, absPath));
}

export function remoteExecutionLabel(config: RemoteRuntimeConfig | null): string {
  if (!config) {
    return "local";
  }
  if (remoteRuntimeMode() === "stub") {
    return "remote-stub";
  }
  return config.sshTarget;
}

export async function localFileExists(pathName: string): Promise<boolean> {
  return existsSync(pathName);
}

export async function readLocalJsonFile<T>(pathName: string): Promise<T | null> {
  if (!existsSync(pathName)) {
    return null;
  }
  try {
    return JSON.parse(await readFile(pathName, "utf8")) as T;
  } catch {
    return null;
  }
}

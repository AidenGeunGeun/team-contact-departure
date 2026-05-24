import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkoutPx4CacheCommit,
  ensurePx4CommitInCache,
  loadStaticSourceConfig,
  resolveTarget,
  StaticSourceError,
} from "./static-source-evidence.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CONFIG_PATH = join(REPO_ROOT, "data", "px4-runtime-replay.json");
const VENV_DIR = join(REPO_ROOT, ".cache", "pymavlink-venv");
const HARNESS_PATH = join(REPO_ROOT, "src", "runners", "px4-runtime-replay-harness.py");
const VENV_SETUP_TIMEOUT_MS = 180_000;
const HARNESS_TIMEOUT_MS = 150_000;

export type Px4RuntimeReplayOutcomeKind =
  | "runtime_clean"
  | "runtime_anomalous"
  | "runtime_unavailable";

export interface Px4RuntimeReplayConfigCase {
  description: string;
  default_target_commit: string;
}

export interface Px4RuntimeReplayBudgetProfile {
  attempt_build: boolean;
  build_timeout_sec: number;
  replay_timeout_sec: number;
  heartbeat_timeout_sec: number;
  observation_sec: number;
}

export interface Px4RuntimeReplayConfig {
  repository: { name: string; url: string };
  static_source_case_id: string;
  pymavlink_version: string;
  python_commands: string[];
  px4_cache_dir: string;
  sitl_binary_relative: string;
  build_manifest_filename?: string;
  mavlink_connection: string;
  cases: Record<string, Px4RuntimeReplayConfigCase>;
  budget_profiles: Record<string, Px4RuntimeReplayBudgetProfile>;
}

export interface PreflightCheck {
  name: string;
  available: boolean;
  detail: string;
  required: boolean;
}

export interface PreflightReport {
  platform: string;
  node_version: string;
  checked_at: string;
  checks: PreflightCheck[];
  all_required_available: boolean;
  px4_root: string;
  px4_binary_path: string;
  px4_binary_present: boolean;
  px4_repo_present: boolean;
}

export interface Px4RuntimeReplayHarnessSummary {
  status:
    | "completed"
    | "setup_failed"
    | "harness_failed"
    | "runtime_unavailable"
    | "runtime_anomalous";
  outcome?: Px4RuntimeReplayOutcomeKind;
  pymavlink_version?: string;
  python_version?: string;
  px4_binary?: string;
  mavlink_connection?: string;
  frame_seed_id?: string;
  frame_delivered?: boolean;
  error?: string;
}

export interface Px4RuntimeReplayEvidence {
  outcome: Px4RuntimeReplayOutcomeKind;
  summary: string;
  caveats: string[];
  pymavlink_version: string;
  python_version: string;
  mavlink_connection: string;
  px4_binary_present: boolean;
  px4_binary_path: string;
  target_commit: string;
  resolved_commit_hash: string;
  frame_delivered: boolean;
  firmware_commit_proven: boolean;
  preflight: PreflightReport;
  setup_note: string;
}

export interface Px4RuntimeReplayFailure {
  summary: string;
  caveats: string[];
  failure_md: string;
  stage: string;
  detail: string;
}

export type Px4RuntimeReplayOutcome =
  | { kind: "evidence"; evidence: Px4RuntimeReplayEvidence }
  | { kind: "failure"; failure: Px4RuntimeReplayFailure };

export class Px4RuntimeReplayValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Px4RuntimeReplayValidationError";
  }
}

export interface ValidatedReplayTarget {
  resolved_commit_hash: string;
  alias?: string;
  role: "pre-patch" | "post-patch";
}

export async function resolvePrePatchCommitHash(
  staticConfig?: Awaited<ReturnType<typeof loadStaticSourceConfig>>,
  replayConfig?: Px4RuntimeReplayConfig,
): Promise<string> {
  const staticCfg = staticConfig ?? (await loadStaticSourceConfig());
  const replayCfg = replayConfig ?? (await loadPx4RuntimeReplayConfig());
  const caseConfig = staticCfg.cases[replayCfg.static_source_case_id];
  return staticCfg.aliases[caseConfig.pre_alias].commit_hash;
}

export async function resolvePostPatchCommitHash(
  staticConfig?: Awaited<ReturnType<typeof loadStaticSourceConfig>>,
  replayConfig?: Px4RuntimeReplayConfig,
): Promise<string> {
  const staticCfg = staticConfig ?? (await loadStaticSourceConfig());
  const replayCfg = replayConfig ?? (await loadPx4RuntimeReplayConfig());
  const caseConfig = staticCfg.cases[replayCfg.static_source_case_id];
  return staticCfg.aliases[caseConfig.post_alias].commit_hash;
}

export function validatePx4RuntimeReplayTarget(
  targetCommit: string,
  replayConfig: Px4RuntimeReplayConfig,
  staticConfig: Awaited<ReturnType<typeof loadStaticSourceConfig>>,
): ValidatedReplayTarget {
  let resolved;
  try {
    resolved = resolveTarget(replayConfig.static_source_case_id, targetCommit, staticConfig);
  } catch (error) {
    if (error instanceof StaticSourceError) {
      throw new Px4RuntimeReplayValidationError(error.message);
    }
    throw error;
  }

  const caseConfig = staticConfig.cases[replayConfig.static_source_case_id];
  const preHash = staticConfig.aliases[caseConfig.pre_alias].commit_hash.toLowerCase();
  const postHash = staticConfig.aliases[caseConfig.post_alias].commit_hash.toLowerCase();
  const hash = resolved.resolved_commit_hash.toLowerCase();

  if (hash !== preHash && hash !== postHash) {
    throw new Px4RuntimeReplayValidationError(
      `target_commit "${targetCommit}" does not resolve to a pinned pre-patch or post-patch commit for this case (expected ${caseConfig.pre_alias}, ${caseConfig.post_alias}, or their commit hashes).`,
    );
  }

  const role = hash === preHash ? "pre-patch" : "post-patch";

  return {
    resolved_commit_hash: resolved.resolved_commit_hash,
    alias: resolved.alias,
    role,
  };
}

export interface ProducePx4RuntimeReplayOptions {
  case_id: string;
  test_card_id: string;
  target_commit: string;
  budget_profile: string;
  artifact_dir: string;
  signal?: AbortSignal;
  onProgress?: (phase: string, progress: number, message: string) => void | Promise<void>;
}

const RUNTIME_REPLAY_CAVEATS = [
  "This is one PX4 runtime replay observation against one crafted MAVLink BATTERY_STATUS frame.",
  "This does not prove firmware safety or that the bounds guard holds under all inputs.",
  "runtime_clean means PX4 stayed up after this single frame delivery, not that no vulnerability exists.",
  "runtime_anomalous means the observation warrants follow-up; it is not by itself a vulnerability verdict.",
];

let cachedConfig: Px4RuntimeReplayConfig | undefined;

export async function loadPx4RuntimeReplayConfig(): Promise<Px4RuntimeReplayConfig> {
  if (cachedConfig) {
    return cachedConfig;
  }
  const raw = await readFile(CONFIG_PATH, "utf8");
  cachedConfig = JSON.parse(raw) as Px4RuntimeReplayConfig;
  return cachedConfig;
}

export function caseUsesPx4RuntimeReplay(
  caseId: string,
  config: Px4RuntimeReplayConfig,
): boolean {
  return Object.prototype.hasOwnProperty.call(config.cases, caseId);
}

function px4Root(config: Px4RuntimeReplayConfig): string {
  return join(REPO_ROOT, config.px4_cache_dir);
}

function px4BinaryPath(config: Px4RuntimeReplayConfig): string {
  return join(px4Root(config), config.sitl_binary_relative);
}

function buildManifestPath(config: Px4RuntimeReplayConfig): string {
  const filename = config.build_manifest_filename ?? ".contact-departure-sitl-build.json";
  return join(px4Root(config), filename);
}

interface SitlBuildManifest {
  commit_hash: string;
  sitl_binary_relative: string;
  binary_path: string;
  built_at: string;
}

async function readBuildManifest(config: Px4RuntimeReplayConfig): Promise<SitlBuildManifest | undefined> {
  const manifestPath = buildManifestPath(config);
  if (!existsSync(manifestPath)) {
    return undefined;
  }
  try {
    const raw = await readFile(manifestPath, "utf8");
    return JSON.parse(raw) as SitlBuildManifest;
  } catch {
    return undefined;
  }
}

async function writeBuildManifest(config: Px4RuntimeReplayConfig, resolvedHash: string): Promise<void> {
  const manifest: SitlBuildManifest = {
    commit_hash: resolvedHash,
    sitl_binary_relative: config.sitl_binary_relative,
    binary_path: px4BinaryPath(config),
    built_at: new Date().toISOString(),
  };
  await writeFile(buildManifestPath(config), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function manifestProvesBinary(
  config: Px4RuntimeReplayConfig,
  manifest: SitlBuildManifest | undefined,
  resolvedHash: string,
): boolean {
  if (!manifest) {
    return false;
  }
  if (manifest.commit_hash.toLowerCase() !== resolvedHash.toLowerCase()) {
    return false;
  }
  if (manifest.sitl_binary_relative !== config.sitl_binary_relative) {
    return false;
  }
  return existsSync(px4BinaryPath(config));
}

function preflightBlocksRuntime(preflight: PreflightReport): { blocked: boolean; reason: string } {
  if (!preflight.all_required_available) {
    const missing = preflight.checks
      .filter((c) => c.required && !c.available)
      .map((c) => c.name)
      .join(", ");
    return {
      blocked: true,
      reason: `Runtime unavailable: required prerequisites missing (${missing}).`,
    };
  }
  return { blocked: false, reason: "" };
}

function runtimeUnavailableAfterSetup(
  budget: Px4RuntimeReplayBudgetProfile,
  setupNote: string,
  binaryPresent: boolean,
): string {
  if (
    setupNote.includes("provenance unverified") ||
    setupNote.includes("no build manifest") ||
    (binaryPresent && setupNote.includes("Build skipped"))
  ) {
    return "Runtime unavailable: a PX4 SITL binary is present but its commit provenance cannot be verified; see px4-setup.log.";
  }
  if (!budget.attempt_build) {
    return "Runtime unavailable: no local PX4 SITL binary is present and this budget profile skips build attempts.";
  }
  if (setupNote.includes("repository not present")) {
    return "Runtime unavailable: PX4 source checkout is not present in the cache, so a SITL binary could not be built.";
  }
  if (setupNote.includes("build failed")) {
    return "Runtime unavailable: a PX4 SITL build was attempted under this budget profile but failed; see px4-setup.log.";
  }
  if (setupNote.includes("binary still missing")) {
    return "Runtime unavailable: PX4 build finished but the expected SITL binary is still missing.";
  }
  if (setupNote.includes("checkout failed")) {
    return "Runtime unavailable: PX4 cache could not be checked out at the resolved commit; see px4-setup.log.";
  }
  return "Runtime unavailable: PX4 SITL binary is not present locally after setup.";
}

function resolveBudgetProfile(
  config: Px4RuntimeReplayConfig,
  budgetProfile: string,
): Px4RuntimeReplayBudgetProfile {
  return (
    config.budget_profiles[budgetProfile] ?? config.budget_profiles["smoke-fast"] ?? {
      attempt_build: false,
      build_timeout_sec: 0,
      replay_timeout_sec: 25,
      heartbeat_timeout_sec: 15,
      observation_sec: 5,
    }
  );
}

function venvPythonPath(): string {
  return process.platform === "win32"
    ? join(VENV_DIR, "Scripts", "python.exe")
    : join(VENV_DIR, "bin", "python3");
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeoutMs?: number;
    logPath?: string;
  } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: options.env,
      stdio: options.logPath ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      if (options.logPath) {
        void appendFile(options.logPath, text, "utf8").catch(() => undefined);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      if (options.logPath) {
        void appendFile(options.logPath, text, "utf8").catch(() => undefined);
      }
    });

    const timeout = options.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
        }, options.timeoutMs)
      : undefined;

    const onAbort = () => {
      child.kill("SIGTERM");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });

    child.on("close", (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted) {
        reject(new Error("Command aborted"));
        return;
      }
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

async function commandAvailable(command: string, args: string[]): Promise<boolean> {
  try {
    const result = await runCommand(command, args, { timeoutMs: 10_000 });
    return result.code === 0;
  } catch {
    return false;
  }
}

async function findSystemPython(config: Px4RuntimeReplayConfig): Promise<string | undefined> {
  for (const candidate of config.python_commands) {
    if (await commandAvailable(candidate, ["--version"])) {
      return candidate;
    }
  }
  return undefined;
}

async function ensureVenv(
  config: Px4RuntimeReplayConfig,
  signal?: AbortSignal,
): Promise<{ pythonPath: string; created: boolean }> {
  const pythonBin = venvPythonPath();
  if (existsSync(pythonBin)) {
    return { pythonPath: pythonBin, created: false };
  }

  const systemPython = await findSystemPython(config);
  if (!systemPython) {
    throw new Error("No usable Python interpreter found (tried python3 and python).");
  }

  await mkdir(dirname(VENV_DIR), { recursive: true });
  const createResult = await runCommand(systemPython, ["-m", "venv", VENV_DIR], {
    signal,
    timeoutMs: VENV_SETUP_TIMEOUT_MS,
  });
  if (createResult.code !== 0) {
    throw new Error(`Failed to create Python venv: ${createResult.stderr || createResult.stdout}`);
  }

  const pipArgs = [
    "-m",
    "pip",
    "install",
    "--disable-pip-version-check",
    "--no-input",
    `pymavlink==${config.pymavlink_version}`,
  ];
  const installResult = await runCommand(pythonBin, pipArgs, {
    signal,
    timeoutMs: VENV_SETUP_TIMEOUT_MS,
  });
  if (installResult.code !== 0) {
    throw new Error(`Failed to install pymavlink: ${installResult.stderr || installResult.stdout}`);
  }

  return { pythonPath: pythonBin, created: true };
}

async function checkPymavlinkPreflight(config: Px4RuntimeReplayConfig): Promise<PreflightCheck> {
  const venvPython = venvPythonPath();
  if (existsSync(venvPython)) {
    const importResult = await runCommand(
      venvPython,
      ["-c", "import pymavlink; print(pymavlink.__version__)"],
      { timeoutMs: 15_000 },
    );
    return {
      name: "pymavlink",
      required: true,
      available: importResult.code === 0,
      detail:
        importResult.code === 0
          ? `pymavlink import OK in ${VENV_DIR}`
          : `pymavlink import failed in ${VENV_DIR}`,
    };
  }

  const systemPython = await findSystemPython(config);
  if (!systemPython) {
    return {
      name: "pymavlink",
      required: true,
      available: false,
      detail: "Python is required to create the pymavlink venv",
    };
  }

  return {
    name: "pymavlink",
    required: true,
    available: true,
    detail: `Python available at ${systemPython}; pymavlink venv will be created if needed`,
  };
}

async function runPreflight(config: Px4RuntimeReplayConfig): Promise<PreflightReport> {
  const root = px4Root(config);
  const binary = px4BinaryPath(config);
  const checks: PreflightCheck[] = [
    {
      name: "git",
      required: true,
      available: await commandAvailable("git", ["--version"]),
      detail: "git --version",
    },
    {
      name: "cmake",
      required: true,
      available: await commandAvailable("cmake", ["--version"]),
      detail: "cmake --version",
    },
    {
      name: "make",
      required: true,
      available: await commandAvailable("make", ["--version"]),
      detail: "make --version",
    },
    {
      name: "g++",
      required: true,
      available:
        (await commandAvailable("g++", ["--version"])) ||
        (await commandAvailable("c++", ["--version"])),
      detail: "g++ --version or c++ --version",
    },
    {
      name: "ninja",
      required: false,
      available: await commandAvailable("ninja", ["--version"]),
      detail: "ninja --version (optional; PX4 may use Make instead)",
    },
    {
      name: "python3",
      required: true,
      available: (await findSystemPython(config)) !== undefined,
      detail: config.python_commands.join(" or "),
    },
    await checkPymavlinkPreflight(config),
  ];

  const repoPresent = existsSync(join(root, ".git"));
  const binaryPresent = existsSync(binary);

  return {
    platform: `${process.platform} ${process.arch}`,
    node_version: process.version,
    checked_at: new Date().toISOString(),
    checks,
    all_required_available: checks.filter((c) => c.required).every((c) => c.available),
    px4_root: root,
    px4_binary_path: binary,
    px4_binary_present: binaryPresent,
    px4_repo_present: repoPresent,
  };
}

async function writePreflightArtifact(artifactDir: string, report: PreflightReport): Promise<void> {
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, "preflight-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const lines = [
    "# PX4 Runtime Replay Preflight",
    "",
    `Platform: ${report.platform}`,
    `Node: ${report.node_version}`,
    `Checked at: ${report.checked_at}`,
    "",
    "| Check | Required | Available | Detail |",
    "| --- | --- | --- | --- |",
    ...report.checks.map(
      (c) => `| ${c.name} | ${c.required ? "yes" : "no"} | ${c.available ? "yes" : "no"} | ${c.detail} |`,
    ),
    "",
    `PX4 cache root: ${report.px4_root}`,
    `PX4 repo present: ${report.px4_repo_present}`,
    `PX4 SITL binary present: ${report.px4_binary_present}`,
    `PX4 SITL binary path: ${report.px4_binary_path}`,
    "",
    ...RUNTIME_REPLAY_CAVEATS,
    "",
  ];
  await writeFile(join(artifactDir, "preflight-report.md"), lines.join("\n"), "utf8");
}

async function writeEvidenceSummary(
  artifactDir: string,
  evidence: Px4RuntimeReplayEvidence,
): Promise<void> {
  const lines = [
    "# PX4 BATTERY_STATUS Runtime Replay Evidence Summary",
    "",
    `Outcome: ${evidence.outcome}`,
    "",
    evidence.summary,
    "",
    "## Target",
    "",
    `- target_commit: ${evidence.target_commit}`,
    `- resolved_commit_hash (target): ${evidence.resolved_commit_hash}`,
    `- firmware commit proven for executed binary: ${evidence.firmware_commit_proven}`,
    "",
    "## Observation",
    "",
    `- MAVLink connection: ${evidence.mavlink_connection}`,
    `- Crafted frame delivered: ${evidence.frame_delivered}`,
    `- PX4 binary present: ${evidence.px4_binary_present}`,
    `- Setup: ${evidence.setup_note}`,
    "",
    "## Caveats",
    "",
    ...evidence.caveats.map((c) => `- ${c}`),
    "",
  ];
  await writeFile(join(artifactDir, "evidence-summary.md"), lines.join("\n"), "utf8");
}

async function appendSetupSummary(artifactDir: string, note: string): Promise<void> {
  await mkdir(artifactDir, { recursive: true });
  await appendFile(join(artifactDir, "px4-setup-summary.txt"), `${note}\n`, "utf8");
  const setupLog = join(artifactDir, "px4-setup.log");
  if (existsSync(setupLog)) {
    await appendFile(setupLog, `\n--- setup summary ---\n${note}\n`, "utf8");
  }
}

async function writeEarlyUnavailableArtifacts(
  artifactDir: string,
  preflight: PreflightReport,
  reason: string,
  setupNote: string,
  targetCommit: string,
  resolvedHash: string,
  options: { writePlaceholderRuntimeArtifacts: boolean },
): Promise<void> {
  if (options.writePlaceholderRuntimeArtifacts) {
    await writeFile(
      join(artifactDir, "delivery-record.json"),
      `${JSON.stringify({ delivery_possible: false, reason }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(artifactDir, "observation-record.json"),
      `${JSON.stringify({ observation_possible: false, reason }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(artifactDir, "runtime.log"),
      `Runtime did not start.\nReason: ${reason}\n`,
      "utf8",
    );
  }
  if (setupNote) {
    await appendSetupSummary(artifactDir, setupNote);
  }
  const evidence: Px4RuntimeReplayEvidence = {
    outcome: "runtime_unavailable",
    summary: reason,
    caveats: RUNTIME_REPLAY_CAVEATS,
    pymavlink_version: "not used",
    python_version: "not used",
    mavlink_connection: "not connected",
    px4_binary_present: preflight.px4_binary_present,
    px4_binary_path: preflight.px4_binary_path,
    target_commit: targetCommit,
    resolved_commit_hash: resolvedHash,
    frame_delivered: false,
    firmware_commit_proven: false,
    preflight,
    setup_note: setupNote,
  };
  await writeEvidenceSummary(artifactDir, evidence);
}

async function finalizeHarnessUnavailableEvidence(
  artifactDir: string,
  preflight: PreflightReport,
  reason: string,
  setupNote: string,
  targetCommit: string,
  resolvedHash: string,
  pymavlinkVersion: string,
  pythonVersion: string,
  mavlinkConnection: string,
): Promise<Px4RuntimeReplayEvidence> {
  await appendSetupSummary(artifactDir, setupNote);
  const evidence: Px4RuntimeReplayEvidence = {
    outcome: "runtime_unavailable",
    summary: reason,
    caveats: RUNTIME_REPLAY_CAVEATS,
    pymavlink_version: pymavlinkVersion,
    python_version: pythonVersion,
    mavlink_connection: mavlinkConnection,
    px4_binary_present: true,
    px4_binary_path: preflight.px4_binary_path,
    target_commit: targetCommit,
    resolved_commit_hash: resolvedHash,
    frame_delivered: false,
    firmware_commit_proven: true,
    preflight,
    setup_note: setupNote,
  };
  await writeEvidenceSummary(artifactDir, evidence);
  return evidence;
}

function parseHarnessSummary(stdout: string): Px4RuntimeReplayHarnessSummary {
  const lines = stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const jsonLine = [...lines].reverse().find((line) => line.startsWith("{"));
  if (!jsonLine) {
    throw new Error("Harness stdout did not contain a JSON summary line.");
  }
  return JSON.parse(jsonLine) as Px4RuntimeReplayHarnessSummary;
}

async function writeSetupFailure(artifactDir: string, stage: string, detail: string): Promise<void> {
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    join(artifactDir, "failure.md"),
    [
      "# PX4 Runtime Replay Setup Failure",
      "",
      `Stage: ${stage}`,
      `Detail: ${detail}`,
      "",
      ...RUNTIME_REPLAY_CAVEATS,
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(artifactDir, "runner.log"), `[setup failure] ${stage}: ${detail}\n`, "utf8");
}

async function preparePx4AtCommit(
  config: Px4RuntimeReplayConfig,
  resolvedHash: string,
  budget: Px4RuntimeReplayBudgetProfile,
  artifactDir: string,
  signal?: AbortSignal,
): Promise<{ setupNote: string; built: boolean; firmwareCommitProven: boolean }> {
  const root = px4Root(config);
  const binary = px4BinaryPath(config);
  const setupLog = join(artifactDir, "px4-setup.log");
  const lines: string[] = [];

  try {
    await ensurePx4CommitInCache(config.repository.url, resolvedHash, signal);
    lines.push(`Ensured commit ${resolvedHash} is available in ${root}.`);
  } catch (error) {
    const detail = error instanceof StaticSourceError ? error.detail : String(error);
    lines.push(`Failed to fetch commit ${resolvedHash}: ${detail}`);
    await writeFile(setupLog, `${lines.join("\n")}\n`, "utf8");
    return {
      setupNote: `PX4 commit fetch failed for ${resolvedHash}; see px4-setup.log.`,
      built: false,
      firmwareCommitProven: false,
    };
  }

  if (!existsSync(join(root, ".git"))) {
    lines.push(`PX4 repository not present at ${root}; clone PX4 into the cache before building.`);
    await writeFile(setupLog, `${lines.join("\n")}\n`, "utf8");
    return {
      setupNote: lines.at(-1) ?? "PX4 repository not present.",
      built: false,
      firmwareCommitProven: false,
    };
  }

  try {
    const checkout = await checkoutPx4CacheCommit(resolvedHash, signal);
    if (checkout.checked_out) {
      lines.push(
        `Checked out PX4 cache at ${resolvedHash} (previous HEAD: ${checkout.previous_head ?? "unknown"}).`,
      );
    } else {
      lines.push(`PX4 cache already at ${resolvedHash}.`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    lines.push(`git checkout failed at ${resolvedHash}: ${detail}`);
    await writeFile(setupLog, `${lines.join("\n")}\n`, "utf8");
    return {
      setupNote: `PX4 checkout failed at ${resolvedHash}; see px4-setup.log.`,
      built: false,
      firmwareCommitProven: false,
    };
  }

  const manifest = await readBuildManifest(config);
  if (manifestProvesBinary(config, manifest, resolvedHash)) {
    lines.push(
      `Reused PX4 SITL binary at ${binary} with verified build manifest for ${resolvedHash} (built_at=${manifest?.built_at}).`,
    );
    await writeFile(setupLog, `${lines.join("\n")}\n`, "utf8");
    return {
      setupNote: lines.at(-1) ?? `Reused verified binary at ${binary}.`,
      built: false,
      firmwareCommitProven: true,
    };
  }

  if (existsSync(binary)) {
    lines.push(
      `PX4 SITL binary exists at ${binary} but no build manifest proves it was built from ${resolvedHash}; treated as unverified.`,
    );
  } else {
    lines.push(`No PX4 SITL binary at ${binary} for ${resolvedHash}.`);
  }

  if (!budget.attempt_build) {
    lines.push(
      `Build skipped (budget profile does not attempt build). Cannot verify or produce a SITL binary for ${resolvedHash}.`,
    );
    await writeFile(setupLog, `${lines.join("\n")}\n`, "utf8");
    return {
      setupNote: lines.at(-1) ?? "Build skipped; binary provenance unverified.",
      built: false,
      firmwareCommitProven: false,
    };
  }

  await writeFile(setupLog, `${lines.join("\n")}\nStarting make px4_sitl_default in ${root}\n`, "utf8");
  const buildResult = await runCommand("make", ["px4_sitl_default", "-j4"], {
    cwd: root,
    signal,
    timeoutMs: budget.build_timeout_sec * 1000,
    logPath: setupLog,
  });
  if (buildResult.code !== 0) {
    return {
      setupNote: `PX4 build failed at ${resolvedHash} (exit ${buildResult.code}). See px4-setup.log.`,
      built: false,
      firmwareCommitProven: false,
    };
  }
  if (!existsSync(binary)) {
    return {
      setupNote: `PX4 build finished at ${resolvedHash} but binary still missing at ${binary}.`,
      built: false,
      firmwareCommitProven: false,
    };
  }
  await writeBuildManifest(config, resolvedHash);
  await appendFile(
    setupLog,
    `\nRecorded build manifest at ${buildManifestPath(config)} for ${resolvedHash}.\n`,
    "utf8",
  );
  return {
    setupNote: `Built PX4 SITL binary at ${binary} for commit ${resolvedHash} and recorded build manifest.`,
    built: true,
    firmwareCommitProven: true,
  };
}

export async function producePx4RuntimeReplayEvidence(
  options: ProducePx4RuntimeReplayOptions,
): Promise<Px4RuntimeReplayOutcome> {
  const config = await loadPx4RuntimeReplayConfig();
  const caseConfig = config.cases[options.case_id];
  if (!caseConfig) {
    throw new Error(`No PX4 runtime replay config for case ${options.case_id}`);
  }

  const staticConfig = await loadStaticSourceConfig();
  let resolvedHash: string;
  try {
    ({ resolved_commit_hash: resolvedHash } = validatePx4RuntimeReplayTarget(
      options.target_commit,
      config,
      staticConfig,
    ));
  } catch (error) {
    if (error instanceof Px4RuntimeReplayValidationError) {
      throw error;
    }
    const detail = error instanceof StaticSourceError ? error.message : String(error);
    throw new Error(`Failed to resolve target_commit: ${detail}`);
  }

  const budget = resolveBudgetProfile(config, options.budget_profile);
  const progress = options.onProgress;

  await mkdir(options.artifact_dir, { recursive: true });
  await writeFile(join(options.artifact_dir, "runner.log"), "", "utf8");

  await progress?.("preflight", 10, "Checking local PX4 runtime replay prerequisites.");
  const preflight = await runPreflight(config);
  await writePreflightArtifact(options.artifact_dir, preflight);

  const preflightGate = preflightBlocksRuntime(preflight);
  if (preflightGate.blocked) {
    const reason = preflightGate.reason;
    await writeEarlyUnavailableArtifacts(
      options.artifact_dir,
      preflight,
      reason,
      "Preflight blocked before PX4 setup.",
      options.target_commit,
      resolvedHash,
      { writePlaceholderRuntimeArtifacts: true },
    );
    return {
      kind: "evidence",
      evidence: {
        outcome: "runtime_unavailable",
        summary: reason,
        caveats: RUNTIME_REPLAY_CAVEATS,
        pymavlink_version: config.pymavlink_version,
        python_version: "not used",
        mavlink_connection: config.mavlink_connection,
        px4_binary_present: preflight.px4_binary_present,
        px4_binary_path: preflight.px4_binary_path,
        target_commit: options.target_commit,
        resolved_commit_hash: resolvedHash,
        frame_delivered: false,
        firmware_commit_proven: false,
        preflight,
        setup_note: "Preflight blocked before PX4 setup.",
      },
    };
  }

  await progress?.("preparing-python-env", 20, "Ensuring pymavlink environment for frame delivery.");
  let pythonPath: string;
  try {
    ({ pythonPath } = await ensureVenv(config, options.signal));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const reason = `Runtime unavailable: pymavlink environment could not be prepared (${detail}).`;
    await writeEarlyUnavailableArtifacts(
      options.artifact_dir,
      preflight,
      reason,
      "Preflight blocked at pymavlink venv preparation.",
      options.target_commit,
      resolvedHash,
      { writePlaceholderRuntimeArtifacts: true },
    );
    return {
      kind: "evidence",
      evidence: {
        outcome: "runtime_unavailable",
        summary: reason,
        caveats: RUNTIME_REPLAY_CAVEATS,
        pymavlink_version: config.pymavlink_version,
        python_version: "not used",
        mavlink_connection: config.mavlink_connection,
        px4_binary_present: preflight.px4_binary_present,
        px4_binary_path: preflight.px4_binary_path,
        target_commit: options.target_commit,
        resolved_commit_hash: resolvedHash,
        frame_delivered: false,
        firmware_commit_proven: false,
        preflight,
        setup_note: "Preflight blocked at pymavlink venv preparation.",
      },
    };
  }

  await progress?.("preparing-frame", 30, "Recording crafted BATTERY_STATUS frame bytes.");
  try {
    await runCommand(
      pythonPath,
      [
        HARNESS_PATH,
        "--artifact-dir",
        options.artifact_dir,
        "--px4-root",
        px4Root(config),
        "--px4-binary",
        px4BinaryPath(config),
        "--prepare-frame-only",
      ],
      { signal: options.signal, timeoutMs: 30_000 },
    );
  } catch (error) {
    if (options.signal?.aborted) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    const reason = `Runtime unavailable: crafted frame record could not be prepared (${detail}).`;
    await writeEarlyUnavailableArtifacts(
      options.artifact_dir,
      preflight,
      reason,
      "Frame preparation failed after preflight.",
      options.target_commit,
      resolvedHash,
      { writePlaceholderRuntimeArtifacts: false },
    );
    return {
      kind: "evidence",
      evidence: {
        outcome: "runtime_unavailable",
        summary: reason,
        caveats: RUNTIME_REPLAY_CAVEATS,
        pymavlink_version: config.pymavlink_version,
        python_version: "unknown",
        mavlink_connection: config.mavlink_connection,
        px4_binary_present: preflight.px4_binary_present,
        px4_binary_path: preflight.px4_binary_path,
        target_commit: options.target_commit,
        resolved_commit_hash: resolvedHash,
        frame_delivered: false,
        firmware_commit_proven: false,
        preflight,
        setup_note: "Frame preparation failed after preflight.",
      },
    };
  }

  await progress?.("px4-setup", 40, "Fetching commit, checking out PX4, and building SITL when allowed.");
  const { setupNote, firmwareCommitProven } = await preparePx4AtCommit(
    config,
    resolvedHash,
    budget,
    options.artifact_dir,
    options.signal,
  );
  await appendSetupSummary(options.artifact_dir, setupNote);

  if (!firmwareCommitProven || !existsSync(px4BinaryPath(config))) {
    const reason = runtimeUnavailableAfterSetup(budget, setupNote, existsSync(px4BinaryPath(config)));
    await writeEarlyUnavailableArtifacts(
      options.artifact_dir,
      preflight,
      reason,
      setupNote,
      options.target_commit,
      resolvedHash,
      { writePlaceholderRuntimeArtifacts: true },
    );
    return {
      kind: "evidence",
      evidence: {
        outcome: "runtime_unavailable",
        summary: reason,
        caveats: RUNTIME_REPLAY_CAVEATS,
        pymavlink_version: config.pymavlink_version,
        python_version: "unknown",
        mavlink_connection: config.mavlink_connection,
        px4_binary_present: existsSync(px4BinaryPath(config)),
        px4_binary_path: preflight.px4_binary_path,
        target_commit: options.target_commit,
        resolved_commit_hash: resolvedHash,
        frame_delivered: false,
        firmware_commit_proven: false,
        preflight,
        setup_note: setupNote,
      },
    };
  }

  await progress?.("runtime-replay", 60, "Launching PX4 SITL and delivering crafted BATTERY_STATUS frame.");
  const harnessTimeoutMs = Math.max(
    budget.replay_timeout_sec * 1000,
    budget.heartbeat_timeout_sec * 1000 + budget.observation_sec * 1000 + 20_000,
    HARNESS_TIMEOUT_MS,
  );

  const harnessArgs = [
    HARNESS_PATH,
    "--artifact-dir",
    options.artifact_dir,
    "--px4-root",
    px4Root(config),
    "--px4-binary",
    px4BinaryPath(config),
    "--mavlink-connection",
    config.mavlink_connection,
    "--replay-timeout-sec",
    String(budget.replay_timeout_sec),
    "--heartbeat-timeout-sec",
    String(budget.heartbeat_timeout_sec),
    "--observation-sec",
    String(budget.observation_sec),
    "--pymavlink-version",
    config.pymavlink_version,
  ];

  let harnessResult: { stdout: string; stderr: string; code: number };
  try {
    harnessResult = await runCommand(pythonPath, harnessArgs, {
      signal: options.signal,
      timeoutMs: harnessTimeoutMs,
    });
    await appendFile(
      join(options.artifact_dir, "runner.log"),
      `Harness exit ${harnessResult.code}\n${harnessResult.stderr}\n`,
      "utf8",
    );
  } catch (error) {
    if (options.signal?.aborted) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    await writeSetupFailure(options.artifact_dir, "harness_launch", detail);
    return {
      kind: "failure",
      failure: {
        summary: `PX4 runtime replay harness failed to launch: ${detail}`,
        caveats: RUNTIME_REPLAY_CAVEATS,
        failure_md: `Setup failed at harness_launch: ${detail}`,
        stage: "harness_launch",
        detail,
      },
    };
  }

  await progress?.("collecting-artifacts", 85, "Collecting PX4 runtime replay artifacts.");

  let summary: Px4RuntimeReplayHarnessSummary;
  try {
    summary = parseHarnessSummary(harnessResult.stdout);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const combined = `${detail}\nstdout:\n${harnessResult.stdout}\nstderr:\n${harnessResult.stderr}`;
    await writeSetupFailure(options.artifact_dir, "harness_output", combined);
    return {
      kind: "failure",
      failure: {
        summary: "PX4 runtime replay harness did not return a parseable summary.",
        caveats: RUNTIME_REPLAY_CAVEATS,
        failure_md: `Setup failed at harness_output: ${combined}`,
        stage: "harness_output",
        detail: combined,
      },
    };
  }

  const outcome = summary.outcome ?? "runtime_anomalous";
  const pymavlinkVersion = summary.pymavlink_version ?? config.pymavlink_version;
  const pythonVersion = summary.python_version ?? "unknown";

  if (summary.status === "harness_failed" || summary.status === "setup_failed") {
    const detail = summary.error ?? harnessResult.stderr ?? harnessResult.stdout;
    await writeSetupFailure(options.artifact_dir, "harness_execution", detail);
    return {
      kind: "failure",
      failure: {
        summary: `PX4 runtime replay harness failed: ${detail}`,
        caveats: RUNTIME_REPLAY_CAVEATS,
        failure_md: `Harness failed: ${detail}`,
        stage: "harness_execution",
        detail,
      },
    };
  }

  if (outcome === "runtime_unavailable") {
    const reason = summary.error ?? "Runtime unavailable during harness execution.";
    const evidence = await finalizeHarnessUnavailableEvidence(
      options.artifact_dir,
      preflight,
      reason,
      setupNote,
      options.target_commit,
      resolvedHash,
      pymavlinkVersion,
      pythonVersion,
      config.mavlink_connection,
    );
    return { kind: "evidence", evidence };
  }

  const frameDelivered = summary.frame_delivered === true;
  const evidenceSummary =
    outcome === "runtime_clean"
      ? `PX4 SITL runtime replay delivered the crafted BATTERY_STATUS frame using firmware with verified build manifest for ${resolvedHash}; PX4 remained running with no abnormal log markers.`
      : outcome === "runtime_anomalous"
        ? `PX4 SITL runtime replay observed unexpected behavior after frame delivery against verified firmware for ${resolvedHash}: ${summary.error ?? "see observation-record.json and runtime.log"}.`
        : outcome === "runtime_unavailable"
          ? summary.error ?? "Runtime unavailable before or during frame delivery."
          : `PX4 runtime replay finished with outcome ${outcome}.`;

  const evidence: Px4RuntimeReplayEvidence = {
    outcome,
    summary: evidenceSummary,
    caveats: RUNTIME_REPLAY_CAVEATS,
    pymavlink_version: pymavlinkVersion,
    python_version: pythonVersion,
    mavlink_connection: summary.mavlink_connection ?? config.mavlink_connection,
    px4_binary_present: true,
    px4_binary_path: preflight.px4_binary_path,
    target_commit: options.target_commit,
    resolved_commit_hash: resolvedHash,
    frame_delivered: frameDelivered,
    firmware_commit_proven: true,
    preflight,
    setup_note: setupNote,
  };
  await writeEvidenceSummary(options.artifact_dir, evidence);

  return { kind: "evidence", evidence };
}

export function px4RuntimeReplayArtifactPaths(
  artifactDirAbs: string,
  outcome: Px4RuntimeReplayOutcome,
): string[] {
  const rel = (name: string) => join(artifactDirAbs, name);
  const candidates =
    outcome.kind === "failure"
      ? [rel("failure.md"), rel("preflight-report.json"), rel("preflight-report.md"), rel("runner.log")]
      : [
          rel("evidence-summary.md"),
          rel("preflight-report.json"),
          rel("preflight-report.md"),
          rel("px4-setup.log"),
          rel("px4-setup-summary.txt"),
          rel("runtime.log"),
          rel("frame-record.json"),
          rel("frame-record.hex"),
          rel("delivery-record.json"),
          rel("observation-record.json"),
          rel("runner.log"),
        ];
  return candidates.filter((path) => existsSync(path));
}

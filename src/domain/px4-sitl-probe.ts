import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CONFIG_PATH = join(REPO_ROOT, "data", "px4-sitl-probe.json");
const VENV_DIR = join(REPO_ROOT, ".cache", "pymavlink-venv");
const HARNESS_PATH = join(REPO_ROOT, "src", "runners", "px4-sitl-probe-harness.py");
const VENV_SETUP_TIMEOUT_MS = 180_000;
const HARNESS_TIMEOUT_MS = 120_000;

export type Px4SitlProbeOutcomeKind =
  | "runtime_observed"
  | "runtime_unavailable"
  | "runtime_abnormal";

export interface Px4SitlProbeConfigCase {
  description: string;
  default_target_commit: string;
}

export interface Px4SitlProbeBudgetProfile {
  attempt_build: boolean;
  build_timeout_sec: number;
  probe_timeout_sec: number;
  heartbeat_timeout_sec: number;
}

export interface Px4SitlProbeConfig {
  repository: { name: string; url: string };
  pymavlink_version: string;
  python_commands: string[];
  px4_cache_dir: string;
  sitl_binary_relative: string;
  mavlink_connection: string;
  cases: Record<string, Px4SitlProbeConfigCase>;
  budget_profiles: Record<string, Px4SitlProbeBudgetProfile>;
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

export interface Px4SitlProbeHarnessSummary {
  status: "completed" | "setup_failed" | "harness_failed" | "runtime_unavailable" | "runtime_abnormal";
  outcome?: Px4SitlProbeOutcomeKind;
  pymavlink_version?: string;
  python_version?: string;
  px4_binary?: string;
  mavlink_connection?: string;
  heartbeat?: Record<string, unknown>;
  error?: string;
}

export interface Px4SitlProbeEvidence {
  outcome: Px4SitlProbeOutcomeKind;
  summary: string;
  caveats: string[];
  pymavlink_version: string;
  python_version: string;
  mavlink_connection: string;
  px4_binary_present: boolean;
  px4_binary_path: string;
  heartbeat_observed: boolean;
  preflight: PreflightReport;
  setup_note: string;
}

export interface Px4SitlProbeFailure {
  summary: string;
  caveats: string[];
  failure_md: string;
  stage: string;
  detail: string;
}

export type Px4SitlProbeOutcome =
  | { kind: "evidence"; evidence: Px4SitlProbeEvidence }
  | { kind: "failure"; failure: Px4SitlProbeFailure };

export interface ProducePx4SitlProbeOptions {
  case_id: string;
  test_card_id: string;
  target_commit: string;
  budget_profile: string;
  artifact_dir: string;
  signal?: AbortSignal;
  onProgress?: (phase: string, progress: number, message: string) => void | Promise<void>;
}

const RUNTIME_PROBE_CAVEATS = [
  "This is PX4 runtime probe evidence from a constrained local SITL boot attempt.",
  "This does not prove firmware safety or that any parser-bounds fix holds at runtime.",
  "This is not MAVLink fuzzing or deterministic replay against PX4.",
];

let cachedConfig: Px4SitlProbeConfig | undefined;

export async function loadPx4SitlProbeConfig(): Promise<Px4SitlProbeConfig> {
  if (cachedConfig) {
    return cachedConfig;
  }
  const raw = await readFile(CONFIG_PATH, "utf8");
  cachedConfig = JSON.parse(raw) as Px4SitlProbeConfig;
  return cachedConfig;
}

export function caseUsesPx4SitlProbe(caseId: string, config: Px4SitlProbeConfig): boolean {
  return Object.prototype.hasOwnProperty.call(config.cases, caseId);
}

function px4Root(config: Px4SitlProbeConfig): string {
  return join(REPO_ROOT, config.px4_cache_dir);
}

function px4BinaryPath(config: Px4SitlProbeConfig): string {
  return join(px4Root(config), config.sitl_binary_relative);
}

function resolveBudgetProfile(
  config: Px4SitlProbeConfig,
  budgetProfile: string,
): Px4SitlProbeBudgetProfile {
  return (
    config.budget_profiles[budgetProfile] ?? config.budget_profiles["smoke-fast"] ?? {
      attempt_build: false,
      build_timeout_sec: 0,
      probe_timeout_sec: 25,
      heartbeat_timeout_sec: 20,
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

async function findSystemPython(config: Px4SitlProbeConfig): Promise<string | undefined> {
  for (const candidate of config.python_commands) {
    if (await commandAvailable(candidate, ["--version"])) {
      return candidate;
    }
  }
  return undefined;
}

async function ensureVenv(
  config: Px4SitlProbeConfig,
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

async function runPreflight(config: Px4SitlProbeConfig): Promise<PreflightReport> {
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
    "# PX4 SITL Probe Preflight",
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
    ...RUNTIME_PROBE_CAVEATS,
    "",
  ];
  await writeFile(join(artifactDir, "preflight-report.md"), lines.join("\n"), "utf8");
}

async function writeEvidenceSummary(
  artifactDir: string,
  evidence: Px4SitlProbeEvidence,
): Promise<void> {
  const lines = [
    "# PX4 SITL Runtime Probe Evidence Summary",
    "",
    `Outcome: ${evidence.outcome}`,
    "",
    evidence.summary,
    "",
    "## Observation",
    "",
    `- MAVLink connection: ${evidence.mavlink_connection}`,
    `- Heartbeat observed: ${evidence.heartbeat_observed}`,
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

async function writeSetupLog(artifactDir: string, note: string, detail = ""): Promise<void> {
  await mkdir(artifactDir, { recursive: true });
  const body = [note, detail].filter(Boolean).join("\n");
  await writeFile(join(artifactDir, "px4-setup.log"), `${body}\n`, "utf8");
}

async function writeRuntimeUnavailableArtifacts(
  artifactDir: string,
  preflight: PreflightReport,
  reason: string,
  setupNote: string,
): Promise<void> {
  await writeFile(
    join(artifactDir, "mavlink-observation.json"),
    `${JSON.stringify({ observation_possible: false, reason }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(artifactDir, "runtime.log"),
    `Runtime did not start.\nReason: ${reason}\n`,
    "utf8",
  );
  await writeSetupLog(artifactDir, setupNote);
  const evidence: Px4SitlProbeEvidence = {
    outcome: "runtime_unavailable",
    summary: reason,
    caveats: RUNTIME_PROBE_CAVEATS,
    pymavlink_version: "not used",
    python_version: "not used",
    mavlink_connection: "not connected",
    px4_binary_present: preflight.px4_binary_present,
    px4_binary_path: preflight.px4_binary_path,
    heartbeat_observed: false,
    preflight,
    setup_note: setupNote,
  };
  await writeEvidenceSummary(artifactDir, evidence);
}

function parseHarnessSummary(stdout: string): Px4SitlProbeHarnessSummary {
  const lines = stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const jsonLine = [...lines].reverse().find((line) => line.startsWith("{"));
  if (!jsonLine) {
    throw new Error("Harness stdout did not contain a JSON summary line.");
  }
  return JSON.parse(jsonLine) as Px4SitlProbeHarnessSummary;
}

async function writeSetupFailure(artifactDir: string, stage: string, detail: string): Promise<void> {
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    join(artifactDir, "failure.md"),
    [
      "# PX4 SITL Probe Setup Failure",
      "",
      `Stage: ${stage}`,
      `Detail: ${detail}`,
      "",
      ...RUNTIME_PROBE_CAVEATS,
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(artifactDir, "runner.log"), `[setup failure] ${stage}: ${detail}\n`, "utf8");
}

async function maybeBuildPx4(
  config: Px4SitlProbeConfig,
  budget: Px4SitlProbeBudgetProfile,
  artifactDir: string,
  signal?: AbortSignal,
): Promise<{ setupNote: string; built: boolean }> {
  const root = px4Root(config);
  const binary = px4BinaryPath(config);
  if (existsSync(binary)) {
    return { setupNote: `Reused existing PX4 SITL binary at ${binary}.`, built: false };
  }
  if (!budget.attempt_build) {
    return {
      setupNote: `Build skipped (budget profile does not attempt build). Expected binary at ${binary}.`,
      built: false,
    };
  }
  if (!existsSync(join(root, ".git"))) {
    return {
      setupNote: `PX4 repository not present at ${root}; clone PX4 into the cache before building.`,
      built: false,
    };
  }

  const setupLog = join(artifactDir, "px4-setup.log");
  await writeFile(setupLog, `Starting make px4_sitl_default in ${root}\n`, "utf8");
  const buildResult = await runCommand("make", ["px4_sitl_default", "-j4"], {
    cwd: root,
    signal,
    timeoutMs: budget.build_timeout_sec * 1000,
    logPath: setupLog,
  });
  if (buildResult.code !== 0) {
    return {
      setupNote: `PX4 build failed (exit ${buildResult.code}). See px4-setup.log.`,
      built: false,
    };
  }
  if (!existsSync(binary)) {
    return {
      setupNote: `PX4 build finished but binary still missing at ${binary}.`,
      built: false,
    };
  }
  return { setupNote: `Built PX4 SITL binary at ${binary}.`, built: true };
}

export async function producePx4SitlProbeEvidence(
  options: ProducePx4SitlProbeOptions,
): Promise<Px4SitlProbeOutcome> {
  const config = await loadPx4SitlProbeConfig();
  const caseConfig = config.cases[options.case_id];
  if (!caseConfig) {
    throw new Error(`No PX4 SITL probe config for case ${options.case_id}`);
  }

  const budget = resolveBudgetProfile(config, options.budget_profile);
  const progress = options.onProgress;

  await mkdir(options.artifact_dir, { recursive: true });
  await writeFile(join(options.artifact_dir, "runner.log"), "", "utf8");

  await progress?.("preflight", 10, "Checking local PX4 runtime prerequisites.");
  const preflight = await runPreflight(config);
  await writePreflightArtifact(options.artifact_dir, preflight);

  if (!preflight.all_required_available) {
    const missing = preflight.checks
      .filter((c) => c.required && !c.available)
      .map((c) => c.name)
      .join(", ");
    const reason = `Runtime unavailable: required build tools missing (${missing}).`;
    await writeRuntimeUnavailableArtifacts(
      options.artifact_dir,
      preflight,
      reason,
      "Preflight blocked before PX4 setup.",
    );
    return {
      kind: "evidence",
      evidence: {
        outcome: "runtime_unavailable",
        summary: reason,
        caveats: RUNTIME_PROBE_CAVEATS,
        pymavlink_version: config.pymavlink_version,
        python_version: "not used",
        mavlink_connection: config.mavlink_connection,
        px4_binary_present: false,
        px4_binary_path: preflight.px4_binary_path,
        heartbeat_observed: false,
        preflight,
        setup_note: "Preflight blocked before PX4 setup.",
      },
    };
  }

  await progress?.("px4-setup", 25, "Checking PX4 SITL binary and optional build.");
  const { setupNote } = await maybeBuildPx4(config, budget, options.artifact_dir, options.signal);
  await writeSetupLog(options.artifact_dir, setupNote);

  if (!existsSync(px4BinaryPath(config))) {
    const reason =
      "Runtime unavailable: PX4 SITL binary is not present locally and this budget profile did not build one.";
    await writeRuntimeUnavailableArtifacts(options.artifact_dir, preflight, reason, setupNote);
    return {
      kind: "evidence",
      evidence: {
        outcome: "runtime_unavailable",
        summary: reason,
        caveats: RUNTIME_PROBE_CAVEATS,
        pymavlink_version: config.pymavlink_version,
        python_version: "not used",
        mavlink_connection: config.mavlink_connection,
        px4_binary_present: false,
        px4_binary_path: preflight.px4_binary_path,
        heartbeat_observed: false,
        preflight,
        setup_note: setupNote,
      },
    };
  }

  await progress?.("preparing-python-env", 40, "Ensuring pymavlink environment for MAVLink observation.");
  let pythonPath: string;
  try {
    ({ pythonPath } = await ensureVenv(config, options.signal));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await writeSetupFailure(options.artifact_dir, "venv_setup", detail);
    return {
      kind: "failure",
      failure: {
        summary: `PX4 SITL probe setup failed during pymavlink venv preparation: ${detail}`,
        caveats: RUNTIME_PROBE_CAVEATS,
        failure_md: `Setup failed at venv_setup: ${detail}`,
        stage: "venv_setup",
        detail,
      },
    };
  }

  await progress?.("runtime-probe", 60, "Launching PX4 SITL and observing MAVLink.");
  const harnessTimeoutMs = Math.max(
    budget.probe_timeout_sec * 1000,
    budget.heartbeat_timeout_sec * 1000 + 15_000,
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
    "--probe-timeout-sec",
    String(budget.probe_timeout_sec),
    "--heartbeat-timeout-sec",
    String(budget.heartbeat_timeout_sec),
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
        summary: `PX4 SITL probe harness failed to launch: ${detail}`,
        caveats: RUNTIME_PROBE_CAVEATS,
        failure_md: `Setup failed at harness_launch: ${detail}`,
        stage: "harness_launch",
        detail,
      },
    };
  }

  await progress?.("collecting-artifacts", 85, "Collecting PX4 runtime probe artifacts.");

  let summary: Px4SitlProbeHarnessSummary;
  try {
    summary = parseHarnessSummary(harnessResult.stdout);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const combined = `${detail}\nstdout:\n${harnessResult.stdout}\nstderr:\n${harnessResult.stderr}`;
    await writeSetupFailure(options.artifact_dir, "harness_output", combined);
    return {
      kind: "failure",
      failure: {
        summary: "PX4 SITL probe harness did not return a parseable summary.",
        caveats: RUNTIME_PROBE_CAVEATS,
        failure_md: `Setup failed at harness_output: ${combined}`,
        stage: "harness_output",
        detail: combined,
      },
    };
  }

  const outcome = summary.outcome ?? "runtime_abnormal";
  const pymavlinkVersion = summary.pymavlink_version ?? config.pymavlink_version;
  const pythonVersion = summary.python_version ?? "unknown";

  if (summary.status === "harness_failed" || summary.status === "setup_failed") {
    const detail = summary.error ?? harnessResult.stderr ?? harnessResult.stdout;
    await writeSetupFailure(options.artifact_dir, "harness_execution", detail);
    return {
      kind: "failure",
      failure: {
        summary: `PX4 SITL probe harness failed: ${detail}`,
        caveats: RUNTIME_PROBE_CAVEATS,
        failure_md: `Harness failed: ${detail}`,
        stage: "harness_execution",
        detail,
      },
    };
  }

  if (outcome === "runtime_unavailable") {
    const reason = summary.error ?? "Runtime unavailable during harness execution.";
    await writeRuntimeUnavailableArtifacts(options.artifact_dir, preflight, reason, setupNote);
    return {
      kind: "evidence",
      evidence: {
        outcome: "runtime_unavailable",
        summary: reason,
        caveats: RUNTIME_PROBE_CAVEATS,
        pymavlink_version: pymavlinkVersion,
        python_version: pythonVersion,
        mavlink_connection: config.mavlink_connection,
        px4_binary_present: true,
        px4_binary_path: preflight.px4_binary_path,
        heartbeat_observed: false,
        preflight,
        setup_note: setupNote,
      },
    };
  }

  const heartbeatObserved = outcome === "runtime_observed";
  const evidenceSummary = heartbeatObserved
    ? "PX4 SITL runtime probe observed a live MAVLink heartbeat from the local instance."
    : outcome === "runtime_abnormal"
      ? `PX4 SITL runtime probe did not observe the expected MAVLink heartbeat: ${summary.error ?? "see mavlink-observation.json and runtime.log"}.`
      : `PX4 SITL runtime probe finished with outcome ${outcome}.`;

  const evidence: Px4SitlProbeEvidence = {
    outcome,
    summary: evidenceSummary,
    caveats: RUNTIME_PROBE_CAVEATS,
    pymavlink_version: pymavlinkVersion,
    python_version: pythonVersion,
    mavlink_connection: summary.mavlink_connection ?? config.mavlink_connection,
    px4_binary_present: true,
    px4_binary_path: preflight.px4_binary_path,
    heartbeat_observed: heartbeatObserved,
    preflight,
    setup_note: setupNote,
  };
  await writeEvidenceSummary(options.artifact_dir, evidence);

  return { kind: "evidence", evidence };
}

export function px4SitlProbeArtifactPaths(
  artifactDirAbs: string,
  outcome: Px4SitlProbeOutcome,
): string[] {
  const rel = (name: string) => join(artifactDirAbs, name);
  if (outcome.kind === "failure") {
    return [rel("failure.md"), rel("preflight-report.json"), rel("preflight-report.md"), rel("runner.log")];
  }
  const paths = [
    rel("evidence-summary.md"),
    rel("preflight-report.json"),
    rel("preflight-report.md"),
    rel("px4-setup.log"),
    rel("runtime.log"),
    rel("mavlink-observation.json"),
    rel("runner.log"),
  ];
  return paths;
}

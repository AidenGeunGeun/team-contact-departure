import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CONFIG_PATH = join(REPO_ROOT, "data", "mavlink-parser-fuzz.json");
const VENV_DIR = join(REPO_ROOT, ".cache", "pymavlink-venv");
const HARNESS_PATH = join(REPO_ROOT, "src", "runners", "mavlink-parser-fuzz-harness.py");
const VENV_SETUP_TIMEOUT_MS = 180_000;
const HARNESS_TIMEOUT_MS = 120_000;

export interface MavlinkParserFuzzConfigCase {
  message_family: string;
  dialect: string;
  seed_descriptions: string[];
}

export interface MavlinkParserFuzzBudgetProfile {
  mutation_budget: number;
  seed_count: number;
}

export interface MavlinkParserFuzzConfig {
  pymavlink_version: string;
  python_commands: string[];
  cases: Record<string, MavlinkParserFuzzConfigCase>;
  budget_profiles: Record<string, MavlinkParserFuzzBudgetProfile>;
  mutation_strategies: string[];
}

export interface MavlinkParserFuzzHarnessSummary {
  status: "completed" | "setup_failed" | "harness_failed";
  verdict?: "no_issue_detected" | "attention_required";
  pymavlink_version?: string;
  python_version?: string;
  dialect?: string;
  message_family?: string;
  mutation_budget?: number;
  inputs_tried?: number;
  exceptions_found?: number;
  mutation_strategies?: string[];
  failure_input_saved?: boolean;
  error?: string;
}

export interface MavlinkParserFuzzEvidence {
  verdict: "no_issue_detected" | "attention_required";
  summary: string;
  caveats: string[];
  pymavlink_version: string;
  python_version: string;
  dialect: string;
  message_family: string;
  mutation_budget: number;
  inputs_tried: number;
  exceptions_found: number;
  mutation_strategies: string[];
  failure_input_saved: boolean;
}

export interface MavlinkParserFuzzFailure {
  summary: string;
  caveats: string[];
  failure_md: string;
  stage: string;
  detail: string;
}

export type MavlinkParserFuzzOutcome =
  | { kind: "evidence"; evidence: MavlinkParserFuzzEvidence }
  | { kind: "failure"; failure: MavlinkParserFuzzFailure };

export interface ProduceMavlinkParserFuzzOptions {
  case_id: string;
  test_card_id: string;
  target_commit: string;
  budget_profile: string;
  artifact_dir: string;
  signal?: AbortSignal;
  onProgress?: (phase: string, progress: number, message: string) => void | Promise<void>;
}

const PARSER_LIBRARY_CAVEATS = [
  "This is parser-library evidence using pymavlink.",
  "This is not PX4 SITL evidence.",
  "This does not prove PX4 MavlinkReceiver runtime behavior.",
];

let cachedConfig: MavlinkParserFuzzConfig | undefined;

export async function loadMavlinkParserFuzzConfig(): Promise<MavlinkParserFuzzConfig> {
  if (cachedConfig) {
    return cachedConfig;
  }
  const raw = await readFile(CONFIG_PATH, "utf8");
  cachedConfig = JSON.parse(raw) as MavlinkParserFuzzConfig;
  return cachedConfig;
}

export function caseUsesMavlinkParserFuzz(caseId: string, config: MavlinkParserFuzzConfig): boolean {
  return Object.prototype.hasOwnProperty.call(config.cases, caseId);
}

function venvPythonPath(): string {
  return process.platform === "win32"
    ? join(VENV_DIR, "Scripts", "python.exe")
    : join(VENV_DIR, "bin", "python3");
}

function resolveBudgetProfile(
  config: MavlinkParserFuzzConfig,
  budgetProfile: string,
): MavlinkParserFuzzBudgetProfile {
  return config.budget_profiles[budgetProfile] ?? config.budget_profiles["smoke-fast"] ?? {
    mutation_budget: 100,
    seed_count: 2,
  };
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
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

async function findSystemPython(config: MavlinkParserFuzzConfig): Promise<string | undefined> {
  for (const candidate of config.python_commands) {
    try {
      const result = await runCommand(candidate, ["--version"], { timeoutMs: 10_000 });
      if (result.code === 0) {
        return candidate;
      }
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

async function ensureVenv(
  config: MavlinkParserFuzzConfig,
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

function parseHarnessSummary(stdout: string): MavlinkParserFuzzHarnessSummary {
  const lines = stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const jsonLine = [...lines].reverse().find((line) => line.startsWith("{"));
  if (!jsonLine) {
    throw new Error("Harness stdout did not contain a JSON summary line.");
  }
  return JSON.parse(jsonLine) as MavlinkParserFuzzHarnessSummary;
}

async function writeSetupFailure(artifactDir: string, stage: string, detail: string): Promise<void> {
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    join(artifactDir, "failure.md"),
    [
      "# MAVLink Parser Fuzz Setup Failure",
      "",
      `Stage: ${stage}`,
      `Detail: ${detail}`,
      "",
      "The parser fuzz runner did not execute a parser budget because setup failed.",
      "",
      ...PARSER_LIBRARY_CAVEATS,
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(artifactDir, "runner.log"), `[setup failure] ${stage}: ${detail}\n`, "utf8");
}

export async function produceMavlinkParserFuzzEvidence(
  options: ProduceMavlinkParserFuzzOptions,
): Promise<MavlinkParserFuzzOutcome> {
  const config = await loadMavlinkParserFuzzConfig();
  const caseConfig = config.cases[options.case_id];
  if (!caseConfig) {
    throw new Error(`No mavlink parser fuzz config for case ${options.case_id}`);
  }

  const budget = resolveBudgetProfile(config, options.budget_profile);
  const progress = options.onProgress;

  await progress?.("preparing-python-env", 10, "Ensuring local pymavlink Python environment.");
  if (options.signal?.aborted) {
    throw new Error("Aborted before venv setup");
  }

  let pythonPath: string;
  try {
    ({ pythonPath } = await ensureVenv(config, options.signal));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await writeSetupFailure(options.artifact_dir, "venv_setup", detail);
    return {
      kind: "failure",
      failure: {
        summary: `MAVLink parser fuzz setup failed during venv preparation: ${detail}`,
        caveats: PARSER_LIBRARY_CAVEATS,
        failure_md: `Setup failed at venv_setup: ${detail}`,
        stage: "venv_setup",
        detail,
      },
    };
  }

  await progress?.("generating-seeds", 25, "Launching pymavlink parser fuzz harness.");
  if (options.signal?.aborted) {
    throw new Error("Aborted before harness launch");
  }

  const harnessArgs = [
    HARNESS_PATH,
    "--artifact-dir",
    options.artifact_dir,
    "--mutation-budget",
    String(budget.mutation_budget),
    "--dialect",
    caseConfig.dialect,
    "--message-family",
    caseConfig.message_family,
    "--strategies",
    config.mutation_strategies.join(","),
    "--seed-descriptions-json",
    JSON.stringify(caseConfig.seed_descriptions),
  ];

  let harnessResult: { stdout: string; stderr: string; code: number };
  try {
    harnessResult = await runCommand(pythonPath, harnessArgs, {
      signal: options.signal,
      timeoutMs: HARNESS_TIMEOUT_MS,
    });
  } catch (error) {
    if (options.signal?.aborted) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    await writeSetupFailure(options.artifact_dir, "harness_launch", detail);
    return {
      kind: "failure",
      failure: {
        summary: `MAVLink parser fuzz harness failed to launch: ${detail}`,
        caveats: PARSER_LIBRARY_CAVEATS,
        failure_md: `Setup failed at harness_launch: ${detail}`,
        stage: "harness_launch",
        detail,
      },
    };
  }

  await progress?.("collecting-artifacts", 85, "Collecting parser fuzz artifacts.");
  if (options.signal?.aborted) {
    throw new Error("Aborted after harness execution");
  }

  let summary: MavlinkParserFuzzHarnessSummary;
  try {
    summary = parseHarnessSummary(harnessResult.stdout);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const combined = `${detail}\nstdout:\n${harnessResult.stdout}\nstderr:\n${harnessResult.stderr}`;
    await writeSetupFailure(options.artifact_dir, "harness_output", combined);
    return {
      kind: "failure",
      failure: {
        summary: "MAVLink parser fuzz harness did not return a parseable summary.",
        caveats: PARSER_LIBRARY_CAVEATS,
        failure_md: `Setup failed at harness_output: ${combined}`,
        stage: "harness_output",
        detail: combined,
      },
    };
  }

  if (summary.status !== "completed" || harnessResult.code !== 0) {
    const detail = summary.error ?? harnessResult.stderr ?? harnessResult.stdout;
    await writeSetupFailure(options.artifact_dir, "harness_execution", detail);
    return {
      kind: "failure",
      failure: {
        summary: `MAVLink parser fuzz harness failed: ${detail}`,
        caveats: PARSER_LIBRARY_CAVEATS,
        failure_md: `Harness failed: ${detail}`,
        stage: "harness_execution",
        detail,
      },
    };
  }

  const exceptions = summary.exceptions_found ?? 0;
  const verdict = summary.verdict ?? (exceptions > 0 ? "attention_required" : "no_issue_detected");
  const inputsTried = summary.inputs_tried ?? 0;
  const pymavlinkVersion = summary.pymavlink_version ?? config.pymavlink_version;

  await progress?.("scoring-evidence", 95, "Scoring parser-library fuzz evidence.");

  return {
    kind: "evidence",
    evidence: {
      verdict,
      summary:
        verdict === "attention_required"
          ? `Parser-library fuzz completed ${inputsTried} inputs and observed ${exceptions} parser exception(s) under the ${options.budget_profile} budget.`
          : `Parser-library fuzz completed ${inputsTried} inputs with no parser exceptions under the ${options.budget_profile} budget.`,
      caveats: PARSER_LIBRARY_CAVEATS,
      pymavlink_version: pymavlinkVersion,
      python_version: summary.python_version ?? "unknown",
      dialect: summary.dialect ?? caseConfig.dialect,
      message_family: summary.message_family ?? caseConfig.message_family,
      mutation_budget: summary.mutation_budget ?? budget.mutation_budget,
      inputs_tried: inputsTried,
      exceptions_found: exceptions,
      mutation_strategies: summary.mutation_strategies ?? config.mutation_strategies,
      failure_input_saved: summary.failure_input_saved ?? false,
    },
  };
}

export function mavlinkParserFuzzArtifactPaths(
  artifactDirAbs: string,
  outcome: MavlinkParserFuzzOutcome,
): string[] {
  const rel = (name: string) => join(artifactDirAbs, name);
  if (outcome.kind === "failure") {
    return [rel("failure.md"), rel("runner.log")];
  }
  const paths = [
    rel("evidence-summary.md"),
    rel("parser-run-manifest.json"),
    rel("parser-outcomes.csv"),
    rel("seed-corpus.json"),
    rel("runner.log"),
  ];
  if (outcome.evidence.failure_input_saved) {
    paths.push(rel("failure-input.bin"), rel("failure-input.hex"));
  }
  return paths;
}

import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMavlinkParserFuzzConfig } from "../domain/mavlink-parser-fuzz.js";
import { buildFullReplayOutcome, buildRefusedReplayOutcome } from "./report.js";
import type { BundleManifest, ReplayOutcome } from "./types.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VENV_DIR = join(REPO_ROOT, ".cache", "pymavlink-venv");
const HARNESS_PATH = join(REPO_ROOT, "src", "runners", "mavlink-parser-fuzz-harness.py");

function venvPythonPath(): string {
  return process.platform === "win32"
    ? join(VENV_DIR, "Scripts", "python.exe")
    : join(VENV_DIR, "bin", "python3");
}

async function readInstalledPymavlinkVersion(pythonPath: string): Promise<string | undefined> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn(
      pythonPath,
      ["-c", "import pymavlink; print(pymavlink.__version__)"],
      { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => {
      if ((code ?? 1) !== 0) {
        resolve(undefined);
        return;
      }
      const version = stdout.trim() || stderr.trim();
      resolve(version || undefined);
    });
  });
}

async function runHarness(
  pythonPath: string,
  artifactDir: string,
  manifest: BundleManifest,
): Promise<{ verdict: string; random_seed: number }> {
  const config = await loadMavlinkParserFuzzConfig();
  const caseConfig = config.cases[manifest.case_id];
  if (!caseConfig) {
    throw new Error(`No parser fuzz config for case ${manifest.case_id}`);
  }
  const mutationBudget = Number(manifest.pinned_inputs.mutation_budget ?? 100);
  const randomSeed = Number(manifest.pinned_inputs.random_seed ?? 42);

  const harnessArgs = [
    HARNESS_PATH,
    "--artifact-dir",
    artifactDir,
    "--mutation-budget",
    String(mutationBudget),
    "--dialect",
    caseConfig.dialect,
    "--message-family",
    caseConfig.message_family,
    "--strategies",
    String(manifest.pinned_inputs.mutation_strategies ?? config.mutation_strategies.join(",")),
    "--seed-descriptions-json",
    JSON.stringify(caseConfig.seed_descriptions),
    "--seed",
    String(randomSeed),
  ];

  const { spawn } = await import("node:child_process");
  const result = await new Promise<{ stdout: string; code: number }>((resolve, reject) => {
    const child = spawn(pythonPath, harnessArgs, { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if ((code ?? 1) !== 0) {
        reject(new Error(stderr || stdout || `Harness exited ${code}`));
        return;
      }
      resolve({ stdout, code: code ?? 0 });
    });
  });

  const lines = result.stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const jsonLine = [...lines].reverse().find((line) => line.startsWith("{"));
  if (!jsonLine) {
    throw new Error("Harness stdout did not contain a JSON summary line.");
  }
  const summary = JSON.parse(jsonLine) as { verdict?: string; random_seed?: number };
  if (!summary.verdict) {
    throw new Error("Harness summary missing verdict.");
  }
  return { verdict: summary.verdict, random_seed: summary.random_seed ?? randomSeed };
}

export async function replayMavlinkParserFuzz(bundleDir: string, manifest: BundleManifest): Promise<ReplayOutcome> {
  const pythonPath = venvPythonPath();
  if (!existsSync(pythonPath)) {
    throw new Error(
      "pymavlink venv not found at .cache/pymavlink-venv; run a parser-fuzz job first or install pymavlink locally.",
    );
  }

  const pinnedVersion = String(manifest.pinned_inputs.pymavlink_version ?? "").trim();
  const installedVersion = await readInstalledPymavlinkVersion(pythonPath);

  if (!pinnedVersion) {
    return buildRefusedReplayOutcome({
      lines: ["Full replay refused: manifest.pinned_inputs.pymavlink_version is missing."],
      recorded_verdict: manifest.recorded_result.verdict,
    });
  }

  if (!installedVersion) {
    return buildRefusedReplayOutcome({
      lines: [
        "Full replay refused: pymavlink is not installed in the venv Python.",
        `Pinned pymavlink_version: ${pinnedVersion}`,
        "Installed pymavlink_version: (missing)",
      ],
      recorded_verdict: manifest.recorded_result.verdict,
    });
  }

  if (installedVersion !== pinnedVersion) {
    return buildRefusedReplayOutcome({
      lines: [
        "Full replay refused: pymavlink version mismatch.",
        `Pinned pymavlink_version: ${pinnedVersion}`,
        `Installed pymavlink_version: ${installedVersion}`,
        "Recreate .cache/pymavlink-venv at the pinned version and retry.",
      ],
      recorded_verdict: manifest.recorded_result.verdict,
    });
  }

  const replayDir = join(bundleDir, ".replay-tmp");
  await mkdir(replayDir, { recursive: true });
  const { verdict: rederived } = await runHarness(pythonPath, replayDir, manifest);
  const recorded = manifest.recorded_result.verdict;
  const pass = rederived === recorded;

  return buildFullReplayOutcome({
    lines: [
      "Full replay: recreated pymavlink venv harness run with pinned random seed and mutation budget.",
      `Pinned random_seed: ${manifest.pinned_inputs.random_seed ?? 42}`,
      `Pinned pymavlink_version: ${pinnedVersion} (verified in venv)`,
      `Installed pymavlink_version: ${installedVersion}`,
    ],
    pass,
    rederived_verdict: rederived,
    recorded_verdict: recorded,
  });
}

export async function readParserFuzzRandomSeed(bundleArtifactsDir: string): Promise<number> {
  const manifestPath = join(bundleArtifactsDir, "parser-run-manifest.json");
  if (!existsSync(manifestPath)) {
    return 42;
  }
  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as { random_seed?: number };
  return typeof raw.random_seed === "number" ? raw.random_seed : 42;
}

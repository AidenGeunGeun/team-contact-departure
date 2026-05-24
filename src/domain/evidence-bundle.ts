import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  type EvidenceResult,
  type JobState,
  type RunnerKind,
} from "./jobs.js";
import { readEvidencePair } from "./evidence-pair.js";
import { readParserFuzzRandomSeed } from "../replay/mavlink-parser-fuzz.js";
import type { BundleManifest, ReplayKind } from "../replay/types.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const BUNDLES_ROOT = join(REPO_ROOT, "bundles");
const RUNS_ROOT = join(REPO_ROOT, "runs");
const PAIRS_ROOT = join(REPO_ROOT, "pairs");

const TERMINAL_STATES = new Set<JobState>(["succeeded", "failed", "cancelled"]);

export interface CreateEvidenceBundleInput {
  job_id?: string;
  pair_id?: string;
}

export interface CreateEvidenceBundleDetails {
  bundle_id: string;
  bundle_dir: string;
  bundle_path: string;
  runner_kind: RunnerKind | "pair";
  replay_kind: ReplayKind;
  replay_command: string;
}

export class EvidenceBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceBundleError";
  }
}

interface JobRecordFile {
  job_id: string;
  request: {
    case_id: string;
    test_card_id: string;
    target_commit: string;
    budget_profile?: string;
  };
}

function toPosixPath(pathName: string): string {
  return pathName.split(sep).join("/");
}

function relativeToRepo(pathName: string): string {
  return toPosixPath(relative(REPO_ROOT, pathName));
}

function createBundleId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `bundle-${timestamp}-${randomUUID().slice(0, 8)}`;
}

function assertSafeJobId(jobId: string): void {
  if (!/^job-[A-Za-z0-9_-]+$/.test(jobId)) {
    throw new EvidenceBundleError(`Invalid job_id: ${jobId}`);
  }
}

function assertSafePairId(pairId: string): void {
  if (!/^pair-[A-Za-z0-9_-]+$/.test(pairId)) {
    throw new EvidenceBundleError(`Invalid pair_id: ${pairId}`);
  }
}

function assertSafeBundleId(bundleId: string): void {
  if (!/^bundle-[A-Za-z0-9_-]+$/.test(bundleId)) {
    throw new EvidenceBundleError(`Invalid bundle_id: ${bundleId}`);
  }
}

function replayCommandFor(bundlePath: string): string {
  return `npm run replay -- ${relativeToRepo(bundlePath)}`;
}

function replayKindFor(runnerKind: RunnerKind | "pair"): { kind: ReplayKind; reason: string } {
  switch (runnerKind) {
    case "fake-smoke":
      return {
        kind: "trivial",
        reason: "Deterministic verdict re-derived from case_id and target_commit with no environment dependencies.",
      };
    case "static-source-evidence":
      return {
        kind: "full",
        reason: "Re-fetches PX4 at the recorded commit and re-runs the static source-pattern check.",
      };
    case "mavlink-parser-fuzz":
      return {
        kind: "full",
        reason: "Recreates the pymavlink harness with the pinned random seed when the local venv exists.",
      };
    case "px4-sitl-probe":
      return {
        kind: "partial",
        reason: "Verifies recorded artifacts only; runtime re-boot requires the original PX4 SITL environment.",
      };
    case "px4-runtime-replay":
      return {
        kind: "partial",
        reason:
          "Verifies frame bytes and artifact structure by default; full frame re-delivery only when a verified PX4 build manifest matches the recorded commit.",
      };
    case "pair":
      return {
        kind: "full",
        reason: "Recomputes pair.json from embedded job results and asserts byte equality.",
      };
    default:
      return { kind: "partial", reason: "Replay behavior is runner-specific." };
  }
}

async function readJson<T>(pathName: string): Promise<T> {
  return JSON.parse(await readFile(pathName, "utf8")) as T;
}

async function copyArtifacts(sourceDir: string, destDir: string): Promise<string[]> {
  await mkdir(destDir, { recursive: true });
  const copied: string[] = [];
  if (!existsSync(sourceDir)) {
    return copied;
  }
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const src = join(sourceDir, entry.name);
    const dest = join(destDir, entry.name);
    await cp(src, dest);
    copied.push(`artifacts/${entry.name}`);
  }
  return copied;
}

async function writeReplayScript(bundleDir: string): Promise<void> {
  const script = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'BUNDLE_DIR="$(cd "$(dirname "$0")" && pwd)"',
    'REPO_ROOT="$(cd "$BUNDLE_DIR/../.." && pwd)"',
    'cd "$REPO_ROOT"',
    'exec node --import tsx scripts/replay.ts "$BUNDLE_DIR"',
    "",
  ].join("\n");
  const scriptPath = join(bundleDir, "replay.sh");
  await writeFile(scriptPath, script, { encoding: "utf8", mode: 0o755 });
}

function buildReadme(manifest: BundleManifest): string {
  return [
    `# Evidence Bundle: ${manifest.bundle_id}`,
    "",
    "## What this bundle proves",
    "",
    `This bundle packages a completed **${manifest.runner_kind}** evidence run for case \`${manifest.case_id}\` (test card \`${manifest.test_card_id}\`).`,
    `Recorded verdict: **${manifest.recorded_result.verdict}**.`,
    "",
    "## Replay",
    "",
    "Replay re-derives the recorded verdict without the LLM, agent session, or any model-facing tool.",
    "",
    "```bash",
    manifest.replay_command,
    "```",
    "",
    "Or run the bundled script from the repository root:",
    "",
    "```bash",
    `./${relativeToRepo(join(BUNDLES_ROOT, manifest.bundle_id, "replay.sh"))}`,
    "```",
    "",
    `Replay kind: **${manifest.replay_kind}** — ${manifest.replay_kind_reason}`,
    "",
    "## What replay does not prove",
    "",
    manifest.replay_kind === "partial"
      ? "- Partial replay verifies recorded artifacts and integrity; it does not re-execute the full runtime environment on its own."
      : "- This bundle does not replace human judgment on supplier risk or certification.",
    manifest.runner_kind === "mavlink-parser-fuzz"
      ? "- Parser-library replay does not prove PX4 firmware runtime behavior."
      : "",
    manifest.runner_kind === "px4-sitl-probe" || manifest.runner_kind === "px4-runtime-replay"
      ? "- Runtime replay/probe bundles do not prove firmware safety or vulnerability discovery."
      : "",
    "",
    "Canonical machine-readable record: `manifest.json`.",
    "",
  ]
    .filter((line, index, arr) => !(line === "" && arr[index - 1] === ""))
    .join("\n");
}

function sha256HexFileContent(hex: string): string {
  return createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex");
}

async function buildPinnedInputs(
  runnerKind: RunnerKind,
  record: JobRecordFile,
  result: EvidenceResult,
  artifactDir: string,
): Promise<Record<string, string | number | boolean>> {
  const pinned: Record<string, string | number | boolean> = {
    target_commit: record.request.target_commit,
    budget_profile: record.request.budget_profile ?? "smoke-fast",
  };

  if (runnerKind === "static-source-evidence" && result.static_source) {
    pinned.px4_commit_hash = result.static_source.resolved_commit_hash;
    if (result.static_source.alias) {
      pinned.commit_alias = result.static_source.alias;
    }
  }

  if (runnerKind === "mavlink-parser-fuzz" && result.mavlink_parser_fuzz) {
    pinned.pymavlink_version = result.mavlink_parser_fuzz.pymavlink_version;
    pinned.mutation_budget = result.mavlink_parser_fuzz.mutation_budget;
    pinned.random_seed = await readParserFuzzRandomSeed(artifactDir);
    pinned.mutation_strategies = result.mavlink_parser_fuzz.mutation_strategies.join(",");
  }

  if (runnerKind === "px4-runtime-replay" && result.px4_runtime_replay) {
    pinned.px4_commit_hash = result.px4_runtime_replay.resolved_commit_hash;
    pinned.pymavlink_version = result.px4_runtime_replay.pymavlink_version;
    const framePath = join(artifactDir, "frame-record.json");
    if (existsSync(framePath)) {
      const frame = await readJson<{ frame_hex?: string }>(framePath);
      if (frame.frame_hex) {
        pinned.frame_bytes_hash = sha256HexFileContent(frame.frame_hex.trim().toLowerCase());
      }
    }
  }

  if (runnerKind === "px4-sitl-probe" && result.px4_sitl_probe) {
    pinned.pymavlink_version = result.px4_sitl_probe.pymavlink_version;
    if (result.px4_sitl_probe.outcome) {
      pinned.runtime_outcome = result.px4_sitl_probe.outcome;
    }
  }

  return pinned;
}

async function loadTerminalJob(jobId: string): Promise<{
  record: JobRecordFile;
  result: EvidenceResult;
  artifactDir: string;
}> {
  assertSafeJobId(jobId);
  const runDir = join(RUNS_ROOT, jobId);
  const status = await readJson<{ state: JobState }>(join(runDir, "status.json"));
  if (!TERMINAL_STATES.has(status.state)) {
    throw new EvidenceBundleError(
      `Job ${jobId} is not terminal (${status.state}). create_evidence_bundle only packages completed jobs.`,
    );
  }
  if (status.state === "cancelled") {
    throw new EvidenceBundleError(
      `Job ${jobId} was cancelled. create_evidence_bundle only packages completed evidence runs.`,
    );
  }
  const record = await readJson<JobRecordFile>(join(runDir, "job.json"));
  const result = await readJson<EvidenceResult>(join(runDir, "result.json"));
  return { record, result, artifactDir: join(runDir, "artifacts") };
}

async function writeBundleManifest(bundleDir: string, manifest: BundleManifest): Promise<void> {
  await writeFile(join(bundleDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export async function createEvidenceBundleFromJob(jobId: string): Promise<CreateEvidenceBundleDetails> {
  const { record, result, artifactDir } = await loadTerminalJob(jobId);
  const runnerKind = result.runner_kind ?? "fake-smoke";
  const { kind: replay_kind, reason: replay_kind_reason } = replayKindFor(runnerKind);

  const bundleId = createBundleId();
  const bundleDir = join(BUNDLES_ROOT, bundleId);
  await mkdir(bundleDir, { recursive: true });
  const artifactsDest = join(bundleDir, "artifacts");
  const artifact_paths = await copyArtifacts(artifactDir, artifactsDest);

  await writeFile(join(bundleDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  const pinned_inputs = await buildPinnedInputs(runnerKind, record, result, artifactDir);
  const replay_command = replayCommandFor(bundleDir);

  const manifest: BundleManifest = {
    schema_version: 1,
    bundle_id: bundleId,
    created_at: new Date().toISOString(),
    runner_kind: runnerKind,
    job_id: jobId,
    case_id: record.request.case_id,
    test_card_id: record.request.test_card_id,
    target_commit: record.request.target_commit,
    budget_profile: record.request.budget_profile ?? "smoke-fast",
    pinned_inputs,
    recorded_result: {
      verdict: result.verdict,
      outcome:
        result.static_source?.verdict_kind ??
        result.px4_runtime_replay?.outcome ??
        result.px4_sitl_probe?.outcome ??
        result.verdict,
      confidence: result.confidence,
      summary: result.summary,
    },
    replay_kind,
    replay_kind_reason,
    replay_command,
    artifact_paths,
  };

  await writeBundleManifest(bundleDir, manifest);
  await writeFile(join(bundleDir, "README.md"), buildReadme(manifest), "utf8");
  await writeReplayScript(bundleDir);

  return {
    bundle_id: bundleId,
    bundle_dir: relativeToRepo(bundleDir),
    bundle_path: relativeToRepo(bundleDir),
    runner_kind: runnerKind,
    replay_kind,
    replay_command,
  };
}

async function copyJobEmbed(runDir: string, role: "pre-patch" | "post-patch", bundleDir: string): Promise<void> {
  const dest = join(bundleDir, "artifacts", "jobs", role);
  await mkdir(dest, { recursive: true });
  await cp(join(runDir, "job.json"), join(dest, "job.json"));
  await cp(join(runDir, "result.json"), join(dest, "result.json"));
  const artifactSrc = join(runDir, "artifacts");
  if (existsSync(artifactSrc)) {
    await cp(artifactSrc, join(dest, "artifacts"), { recursive: true });
  }
}

export async function createEvidenceBundleFromPair(pairId: string): Promise<CreateEvidenceBundleDetails> {
  assertSafePairId(pairId);
  const pair = await readEvidencePair(pairId);
  if (!pair) {
    throw new EvidenceBundleError(`Pair not found: ${pairId}`);
  }

  const preJobId = pair.pre_patch.job_id;
  const postJobId = pair.post_patch.job_id;
  await loadTerminalJob(preJobId);
  await loadTerminalJob(postJobId);

  const bundleId = createBundleId();
  const bundleDir = join(BUNDLES_ROOT, bundleId);
  await mkdir(bundleDir, { recursive: true });

  const pairSource = join(PAIRS_ROOT, pairId, "pair.json");
  await cp(pairSource, join(bundleDir, "pair.json"));

  await copyJobEmbed(join(RUNS_ROOT, preJobId), "pre-patch", bundleDir);
  await copyJobEmbed(join(RUNS_ROOT, postJobId), "post-patch", bundleDir);

  const artifact_paths = [
    "pair.json",
    "artifacts/jobs/pre-patch/job.json",
    "artifacts/jobs/pre-patch/result.json",
    "artifacts/jobs/post-patch/job.json",
    "artifacts/jobs/post-patch/result.json",
  ];

  const { kind: replay_kind, reason: replay_kind_reason } = replayKindFor("pair");
  const replay_command = replayCommandFor(bundleDir);

  const manifest: BundleManifest = {
    schema_version: 1,
    bundle_id: bundleId,
    created_at: new Date().toISOString(),
    runner_kind: "pair",
    pair_id: pairId,
    case_id: pair.case_id,
    test_card_id: pair.test_card_id,
    target_commit: `${pair.pre_patch.target_commit} vs ${pair.post_patch.target_commit}`,
    budget_profile: pair.pre_patch.budget_profile ?? "smoke-fast",
    pinned_inputs: {
      pre_patch_job_id: preJobId,
      post_patch_job_id: postJobId,
      verdict_flip_demonstrated: pair.verdict_flip_demonstrated,
    },
    recorded_result: {
      verdict: "pair_record_valid",
      outcome: pair.verdict_flip_demonstrated ? "verdict_flip_demonstrated" : "verdict_flip_not_demonstrated",
      summary: `Evidence pair ${pairId} with verdict_flip_demonstrated=${pair.verdict_flip_demonstrated}`,
    },
    replay_kind,
    replay_kind_reason,
    replay_command,
    artifact_paths,
  };

  await writeBundleManifest(bundleDir, manifest);
  await writeFile(join(bundleDir, "README.md"), buildReadme(manifest), "utf8");
  await writeReplayScript(bundleDir);

  return {
    bundle_id: bundleId,
    bundle_dir: relativeToRepo(bundleDir),
    bundle_path: relativeToRepo(bundleDir),
    runner_kind: "pair",
    replay_kind,
    replay_command,
  };
}

export async function createEvidenceBundle(
  params: CreateEvidenceBundleInput,
): Promise<CreateEvidenceBundleDetails> {
  const hasJob = Boolean(params.job_id);
  const hasPair = Boolean(params.pair_id);
  if (hasJob === hasPair) {
    throw new EvidenceBundleError("Provide exactly one of job_id or pair_id.");
  }
  if (params.job_id) {
    return createEvidenceBundleFromJob(params.job_id);
  }
  return createEvidenceBundleFromPair(params.pair_id!);
}

export async function readBundleManifest(bundleId: string): Promise<BundleManifest | undefined> {
  assertSafeBundleId(bundleId);
  const path = join(BUNDLES_ROOT, bundleId, "manifest.json");
  if (!existsSync(path)) {
    return undefined;
  }
  return readJson<BundleManifest>(path);
}

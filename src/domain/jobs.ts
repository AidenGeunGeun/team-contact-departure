import { mkdir, readFile, writeFile, appendFile, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadCase, loadTestCard, type CuratedCase, type TestCard } from "./catalog.js";
import {
  loadMavlinkParserFuzzConfig,
  mavlinkParserFuzzArtifactPaths,
  produceMavlinkParserFuzzEvidence,
  type MavlinkParserFuzzConfig,
  type MavlinkParserFuzzOutcome,
} from "./mavlink-parser-fuzz.js";
import {
  loadPx4RuntimeReplayConfig,
  px4RuntimeReplayArtifactPaths,
  producePx4RuntimeReplayEvidence,
  validatePx4RuntimeReplayTarget,
  Px4RuntimeReplayValidationError,
  type Px4RuntimeReplayConfig,
  type Px4RuntimeReplayOutcome,
  type Px4RuntimeReplayOutcomeKind,
} from "./px4-runtime-replay.js";
import {
  loadPx4SitlProbeConfig,
  px4SitlProbeArtifactPaths,
  producePx4SitlProbeEvidence,
  type Px4SitlProbeConfig,
  type Px4SitlProbeOutcome,
  type Px4SitlProbeOutcomeKind,
} from "./px4-sitl-probe.js";
import {
  loadStaticSourceConfig,
  produceStaticSourceEvidence,
  type StaticSourceConfig,
  type StaticSourceOutcome,
  type VerdictKind as StaticVerdictKind,
} from "./static-source-evidence.js";

export type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface LaunchEvidenceJobInput {
  case_id: string;
  test_card_id: string;
  target_commit: string;
  budget_profile?: string;
}

export interface InspectJobInput {
  job_id: string;
}

export interface CancelJobInput {
  job_id: string;
}

export interface JobStatus {
  job_id: string;
  state: JobState;
  phase: string;
  progress: number;
  created_at: string;
  updated_at: string;
  started_at?: string;
  finished_at?: string;
  cancelled_at?: string;
  run_dir: string;
  artifact_dir: string;
  runner?: JobRunnerMetadata;
  message: string;
}

export interface JobEvent {
  timestamp: string;
  state: JobState;
  phase: string;
  progress: number;
  message: string;
}

export interface EvidenceSignal {
  name: string;
  value: string | number | boolean;
  interpretation: string;
}

export type RunnerKind =
  | "fake-smoke"
  | "static-source-evidence"
  | "mavlink-parser-fuzz"
  | "px4-sitl-probe"
  | "px4-runtime-replay";

export interface EvidenceResult {
  job_id: string;
  state: JobState;
  verdict: "attention_required" | "mitigation_observed" | "no_issue_detected" | "manual_review_needed" | "runner_failed" | "cancelled";
  confidence: "low" | "medium" | "high";
  summary: string;
  evidence_signals: EvidenceSignal[];
  artifact_paths: string[];
  cautions: string[];
  completed_at: string;
  runner_kind?: RunnerKind;
  static_source?: StaticSourceResultMetadata;
  mavlink_parser_fuzz?: MavlinkParserFuzzResultMetadata;
  px4_sitl_probe?: Px4SitlProbeResultMetadata;
  px4_runtime_replay?: Px4RuntimeReplayResultMetadata;
}

export interface Px4RuntimeReplayResultMetadata {
  case_id: string;
  test_card_id: string;
  target_commit: string;
  resolved_commit_hash: string;
  outcome?: Px4RuntimeReplayOutcomeKind;
  failure_stage?: string;
  pymavlink_version: string;
  python_version: string;
  mavlink_connection: string;
  frame_delivered: boolean;
  firmware_commit_proven: boolean;
  px4_binary_present: boolean;
  budget_profile: string;
  build_method?: string;
  binary_path?: string;
  sanitizers_used: string[];
  sanitizer_findings?: Array<{
    kind: string;
    message: string;
    source_location?: string;
    context?: string;
  }>;
}

export interface Px4SitlProbeResultMetadata {
  case_id: string;
  test_card_id: string;
  target_commit: string;
  outcome?: Px4SitlProbeOutcomeKind;
  failure_stage?: string;
  pymavlink_version: string;
  python_version: string;
  mavlink_connection: string;
  heartbeat_observed: boolean;
  px4_binary_present: boolean;
  budget_profile: string;
}

export interface MavlinkParserFuzzResultMetadata {
  case_id: string;
  test_card_id: string;
  target_commit: string;
  pymavlink_version: string;
  python_version: string;
  dialect: string;
  message_family: string;
  mutation_budget: number;
  inputs_tried: number;
  exceptions_found: number;
  mutation_strategies: string[];
  budget_profile: string;
}

export interface StaticSourceResultMetadata {
  case_id: string;
  test_card_id: string;
  target_commit: string;
  resolved_commit_hash: string;
  verdict_kind: StaticVerdictKind;
  alias?: string;
  pair_alias?: string;
  role?: "pre-patch" | "post-patch";
  target_file: string;
  target_function: string;
  source_region?: {
    start_line: number;
    end_line: number;
  };
  diff_pre_hash?: string;
  diff_post_hash?: string;
  diff_files_changed?: string[];
  pr_url: string;
  failure_stage?: string;
}

export interface JobRunnerProcessMetadata {
  pid: number;
  launched_at: string;
  entrypoint: string;
  detached: boolean;
  cancel_signal: "SIGTERM";
}

export interface JobRunnerMetadata {
  type: RunnerKind;
  expected_duration_ms: number;
  process?: JobRunnerProcessMetadata;
}

export interface JobLaunchDetails {
  job_id: string;
  state: JobState;
  phase: string;
  progress: number;
  run_dir: string;
  artifact_dir: string;
  runner?: JobRunnerMetadata;
}

export interface JobInspectionDetails {
  job_id: string;
  state: JobState;
  phase: string;
  progress: number;
  run_dir: string;
  artifact_dir: string;
  recent_events: JobEvent[];
  result?: EvidenceResult;
  artifact_paths?: string[];
  runner?: JobRunnerMetadata;
  message: string;
}

export interface JobCancellationDetails extends JobInspectionDetails {
  cancel_action: "cancelled" | "already_terminal";
}

interface JobRecord {
  job_id: string;
  launched_at: string;
  request: Required<LaunchEvidenceJobInput>;
  resolved_case: CuratedCase;
  resolved_test_card: TestCard;
  runner: JobRunnerMetadata;
}

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RUNS_ROOT = join(REPO_ROOT, "runs");
const FAKE_RUNNER_ENTRYPOINT = "src/runners/fake-evidence-runner.ts";
const FAKE_RUNNER_SCRIPT_PATH = fileURLToPath(new URL("../runners/fake-evidence-runner.ts", import.meta.url));
const STATIC_SOURCE_RUNNER_ENTRYPOINT = "src/runners/static-source-evidence-runner.ts";
const STATIC_SOURCE_RUNNER_SCRIPT_PATH = fileURLToPath(
  new URL("../runners/static-source-evidence-runner.ts", import.meta.url),
);
const MAVLINK_PARSER_FUZZ_RUNNER_ENTRYPOINT = "src/runners/mavlink-parser-fuzz-runner.ts";
const MAVLINK_PARSER_FUZZ_RUNNER_SCRIPT_PATH = fileURLToPath(
  new URL("../runners/mavlink-parser-fuzz-runner.ts", import.meta.url),
);
const PX4_SITL_PROBE_RUNNER_ENTRYPOINT = "src/runners/px4-sitl-probe-runner.ts";
const PX4_SITL_PROBE_RUNNER_SCRIPT_PATH = fileURLToPath(
  new URL("../runners/px4-sitl-probe-runner.ts", import.meta.url),
);
const PX4_RUNTIME_REPLAY_RUNNER_ENTRYPOINT = "src/runners/px4-runtime-replay-runner.ts";
const PX4_RUNTIME_REPLAY_RUNNER_SCRIPT_PATH = fileURLToPath(
  new URL("../runners/px4-runtime-replay-runner.ts", import.meta.url),
);
const RUNNER_CANCEL_SIGNAL = "SIGTERM" as const;
const JOB_LOCK_DIR_NAME = ".state-lock";
const JOB_FILE_LOCK_TIMEOUT_MS = 5000;
const JOB_FILE_LOCK_POLL_MS = 10;
const FAKE_STEP_DELAY_MS = 250;
const STATIC_SOURCE_EXPECTED_DURATION_MS = 120_000;
const MAVLINK_PARSER_FUZZ_EXPECTED_DURATION_MS = 180_000;
const PX4_SITL_PROBE_EXPECTED_DURATION_MS = 180_000;
const PX4_RUNTIME_REPLAY_EXPECTED_DURATION_MS = 240_000;
const FAKE_STEPS = [
  {
    phase: "preparing-fixtures",
    progress: 20,
    message: "Resolved curated case and fake runner fixtures.",
  },
  {
    phase: "executing-smoke-replay",
    progress: 50,
    message: "Ran fake telemetry/path probes against the requested target commit.",
  },
  {
    phase: "collecting-artifacts",
    progress: 75,
    message: "Wrote placeholder traces and evidence tables.",
  },
  {
    phase: "scoring-evidence",
    progress: 95,
    message: "Scored evidence signals and prepared the structured result.",
  },
] as const;

const jobLocks = new Map<string, Promise<void>>();

function nowIso(): string {
  return new Date().toISOString();
}

function toPosixPath(pathName: string): string {
  return pathName.split(sep).join("/");
}

function relativeToRepo(pathName: string): string {
  return toPosixPath(relative(REPO_ROOT, pathName));
}

function createJobId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `job-${timestamp}-${randomUUID().slice(0, 8)}`;
}

function assertSafeJobId(jobId: string): void {
  if (!/^job-[A-Za-z0-9_-]+$/.test(jobId)) {
    throw new Error(`Invalid job_id: ${jobId}`);
  }
}

function jobPaths(jobId: string): {
  runDirAbs: string;
  artifactDirAbs: string;
  jobPath: string;
  statusPath: string;
  eventsPath: string;
  resultPath: string;
  runDir: string;
  artifactDir: string;
} {
  assertSafeJobId(jobId);
  const runDirAbs = join(RUNS_ROOT, jobId);
  const artifactDirAbs = join(runDirAbs, "artifacts");
  return {
    runDirAbs,
    artifactDirAbs,
    jobPath: join(runDirAbs, "job.json"),
    statusPath: join(runDirAbs, "status.json"),
    eventsPath: join(runDirAbs, "events.jsonl"),
    resultPath: join(runDirAbs, "result.json"),
    runDir: relativeToRepo(runDirAbs),
    artifactDir: relativeToRepo(artifactDirAbs),
  };
}

async function writeJson(pathName: string, value: unknown): Promise<void> {
  await mkdir(dirname(pathName), { recursive: true });
  const tempPath = `${pathName}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, pathName);
}

async function readJson<T>(pathName: string): Promise<T> {
  const raw = await readFile(pathName, "utf8");
  return JSON.parse(raw) as T;
}

async function appendEvent(jobId: string, event: JobEvent): Promise<void> {
  const paths = jobPaths(jobId);
  await appendFile(paths.eventsPath, `${JSON.stringify(event)}\n`, "utf8");
}

async function writeStatus(status: JobStatus): Promise<void> {
  const paths = jobPaths(status.job_id);
  await writeJson(paths.statusPath, status);
}

async function readStatus(jobId: string): Promise<JobStatus> {
  const paths = jobPaths(jobId);
  return readJson<JobStatus>(paths.statusPath);
}

async function acquireJobFileLock(jobId: string): Promise<() => Promise<void>> {
  const paths = jobPaths(jobId);
  const lockDir = join(paths.runDirAbs, JOB_LOCK_DIR_NAME);
  const deadline = Date.now() + JOB_FILE_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      await mkdir(lockDir);
      try {
        await writeJson(join(lockDir, "owner.json"), {
          pid: process.pid,
          acquired_at: nowIso(),
        });
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true });
        throw error;
      }
      return async () => {
        await rm(lockDir, { recursive: true, force: true });
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for job state lock for ${jobId}.`);
      }
      await delay(JOB_FILE_LOCK_POLL_MS);
    }
  }
}

async function withJobFileLock<T>(jobId: string, action: () => Promise<T>): Promise<T> {
  const release = await acquireJobFileLock(jobId);
  try {
    return await action();
  } finally {
    await release();
  }
}

async function withJobLock<T>(jobId: string, action: () => Promise<T>): Promise<T> {
  const previous = jobLocks.get(jobId) ?? Promise.resolve();
  let release: () => void = () => {};
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.catch(() => undefined).then(() => next);
  jobLocks.set(jobId, chain);
  await previous.catch(() => undefined);
  try {
    return await withJobFileLock(jobId, action);
  } finally {
    release();
    if (jobLocks.get(jobId) === chain) {
      jobLocks.delete(jobId);
    }
  }
}

async function updateStatusUnlocked(
  jobId: string,
  patch: Partial<Omit<JobStatus, "job_id" | "created_at" | "run_dir" | "artifact_dir">>,
): Promise<JobStatus> {
  const current = await readStatus(jobId);
  if (terminal(current.state)) {
    return current;
  }
  const updated: JobStatus = {
    ...current,
    ...patch,
    updated_at: nowIso(),
  };
  await writeStatus(updated);
  await appendEvent(jobId, {
    timestamp: updated.updated_at,
    state: updated.state,
    phase: updated.phase,
    progress: updated.progress,
    message: updated.message,
  });
  return updated;
}

async function updateStatus(
  jobId: string,
  patch: Partial<Omit<JobStatus, "job_id" | "created_at" | "run_dir" | "artifact_dir">>,
): Promise<JobStatus> {
  return withJobLock(jobId, () => updateStatusUnlocked(jobId, patch));
}

async function readRecentEvents(jobId: string, limit = 5): Promise<JobEvent[]> {
  const paths = jobPaths(jobId);
  if (!existsSync(paths.eventsPath)) {
    return [];
  }
  const raw = await readFile(paths.eventsPath, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .map((line) => JSON.parse(line) as JobEvent);
}

async function readResultIfPresent(jobId: string): Promise<EvidenceResult | undefined> {
  const paths = jobPaths(jobId);
  if (!existsSync(paths.resultPath)) {
    return undefined;
  }
  return readJson<EvidenceResult>(paths.resultPath);
}

async function readJobRecord(jobId: string): Promise<JobRecord> {
  const paths = jobPaths(jobId);
  return readJson<JobRecord>(paths.jobPath);
}

function terminal(state: JobState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

function stableHash(input: string): number {
  let hash = 0;
  for (const char of input) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash;
}

function artifactPaths(jobId: string): string[] {
  const paths = jobPaths(jobId);
  return [
    relativeToRepo(join(paths.artifactDirAbs, "evidence-summary.md")),
    relativeToRepo(join(paths.artifactDirAbs, "fake-runner-trace.json")),
    relativeToRepo(join(paths.artifactDirAbs, "signal-table.csv")),
  ];
}

function buildEvidenceResult(record: JobRecord, completedAt: string): EvidenceResult {
  const caseId = record.request.case_id;
  const targetCommit = record.request.target_commit;
  const hash = stableHash(`${caseId}:${targetCommit}`);
  const artifacts = artifactPaths(record.job_id);

  if (targetCommit.includes("runner-fail-demo")) {
    return {
      job_id: record.job_id,
      state: "failed",
      verdict: "runner_failed",
      confidence: "low",
      summary: "The fake runner intentionally reported a harness failure for the runner-fail-demo target string.",
      evidence_signals: [
        {
          name: "runner_health",
          value: "failed",
          interpretation: "This is a fake runner failure path, not firmware evidence.",
        },
      ],
      artifact_paths: artifacts,
      cautions: ["Treat this as a smoke-test failure path only."],
      completed_at: completedAt,
      runner_kind: "fake-smoke",
    };
  }

  if (caseId === "unclear-telemetry-dropout-claim") {
    return {
      job_id: record.job_id,
      state: "succeeded",
      verdict: "manual_review_needed",
      confidence: "low",
      summary: "The fake review found the claim too vague for a strong automated conclusion and captured follow-up evidence needs.",
      evidence_signals: [
        {
          name: "claim_specificity",
          value: "low",
          interpretation: "The snippet lacks message type, trigger, and acceptance threshold.",
        },
        {
          name: "manual_questions_recorded",
          value: true,
          interpretation: "The result is intentionally cautious for unclear supplier claims.",
        },
      ],
      artifact_paths: artifacts,
      cautions: ["Request a concrete message family, trigger, and pass/fail threshold before stronger testing."],
      completed_at: completedAt,
      runner_kind: "fake-smoke",
    };
  }

  const traversalRejected = hash % 2 === 0 || targetCommit.includes("post-patch-demo");
  return {
    job_id: record.job_id,
    state: "succeeded",
    verdict: traversalRejected ? "no_issue_detected" : "attention_required",
    confidence: "medium",
    summary: traversalRejected
      ? "The fake path-handling smoke shows traversal-style FTP paths rejected while ordinary mission-storage reads remain accepted."
      : "The fake path-handling smoke shows at least one traversal-style FTP path was not rejected by the demo target.",
    evidence_signals: [
      {
        name: "parent_directory_traversal_rejected",
        value: traversalRejected,
        interpretation: traversalRejected
          ? "Demo evidence suggests path normalization is effective for the fixture."
          : "Demo evidence suggests the path claim needs attention.",
      },
      {
        name: "ordinary_storage_read_accepted",
        value: true,
        interpretation: "The fake runner keeps a normal mission-storage path in the accepted set.",
      },
    ],
    artifact_paths: artifacts,
    cautions: ["Fake runner only; no host filesystem access was performed."],
    completed_at: completedAt,
    runner_kind: "fake-smoke",
  };
}

async function writeArtifacts(record: JobRecord, result: EvidenceResult): Promise<void> {
  const paths = jobPaths(record.job_id);
  await mkdir(paths.artifactDirAbs, { recursive: true });
  await writeFile(
    join(paths.artifactDirAbs, "evidence-summary.md"),
    [
      `# Fake Evidence Summary: ${record.job_id}`,
      "",
      `Case: ${record.resolved_case.title}`,
      `Test card: ${record.resolved_test_card.title}`,
      `Target commit: ${record.request.target_commit}`,
      `Verdict: ${result.verdict}`,
      "",
      result.summary,
      "",
      "Caution: This is fake smoke-runner output, not PX4/SITL evidence.",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeJson(join(paths.artifactDirAbs, "fake-runner-trace.json"), {
    job_id: record.job_id,
    runner: record.runner,
    request: record.request,
    evidence_signals: result.evidence_signals,
  });
  await writeFile(
    join(paths.artifactDirAbs, "signal-table.csv"),
    [
      "name,value,interpretation",
      ...result.evidence_signals.map((signal) =>
        [signal.name, String(signal.value), signal.interpretation.replaceAll('"', '""')]
          .map((value) => `"${value}"`)
          .join(","),
      ),
      "",
    ].join("\n"),
    "utf8",
  );
}

function buildCancelledResult(
  jobId: string,
  completedAt: string,
  runnerKind?: RunnerKind,
): EvidenceResult {
  return {
    job_id: jobId,
    state: "cancelled",
    verdict: "cancelled",
    confidence: "low",
    summary: "The evidence job was cancelled before it produced evidence.",
    evidence_signals: [],
    artifact_paths: [],
    cautions: ["No evidence conclusion is available for a cancelled job."],
    completed_at: completedAt,
    runner_kind: runnerKind,
  };
}

async function completeCancelled(
  jobId: string,
  message = "Cancellation requested; standalone fake runner stopped before completion.",
): Promise<JobStatus> {
  return withJobLock(jobId, async () => {
    const current = await readStatus(jobId);
    if (terminal(current.state)) {
      return current;
    }
    const completedAt = nowIso();
    const finalStatus = await updateStatusUnlocked(jobId, {
      state: "cancelled",
      phase: "cancelled",
      finished_at: completedAt,
      cancelled_at: completedAt,
      message,
    });
    if (finalStatus.state === "cancelled") {
      const paths = jobPaths(jobId);
      await writeJson(
        paths.resultPath,
        buildCancelledResult(jobId, finalStatus.finished_at ?? completedAt, finalStatus.runner?.type),
      );
    }
    return finalStatus;
  });
}

async function shouldStopRunner(jobId: string): Promise<boolean> {
  const status = await readStatus(jobId);
  return terminal(status.state);
}

async function completeWithResult(record: JobRecord, result: EvidenceResult): Promise<JobStatus> {
  return withJobLock(record.job_id, async () => {
    const current = await readStatus(record.job_id);
    if (terminal(current.state)) {
      return current;
    }
    await writeArtifacts(record, result);
    const beforeResult = await readStatus(record.job_id);
    if (terminal(beforeResult.state)) {
      return beforeResult;
    }
    const paths = jobPaths(record.job_id);
    await writeJson(paths.resultPath, result);
    const finalStatus = await updateStatusUnlocked(record.job_id, {
      state: result.state,
      phase: result.state === "failed" ? "failed" : "complete",
      progress: 100,
      finished_at: result.completed_at,
      message: result.state === "failed" ? result.summary : "Fake evidence job completed successfully.",
    });
    if (finalStatus.state === "cancelled" && finalStatus.state !== result.state) {
      await writeJson(
        paths.resultPath,
        buildCancelledResult(record.job_id, finalStatus.finished_at ?? nowIso(), finalStatus.runner?.type),
      );
    }
    return finalStatus;
  });
}

async function completeFailedJob(jobId: string, message: string): Promise<JobStatus> {
  return withJobLock(jobId, async () => {
    const current = await readStatus(jobId);
    if (terminal(current.state)) {
      return current;
    }
    const failedAt = nowIso();
    const paths = jobPaths(jobId);
    const runnerKind = current.runner?.type;
    const summary =
      runnerKind === "static-source-evidence"
        ? `The static-source evidence runner failed: ${message}`
        : runnerKind === "mavlink-parser-fuzz"
          ? `The MAVLink parser fuzz runner failed: ${message}`
          : runnerKind === "px4-sitl-probe"
            ? `The PX4 SITL probe runner failed: ${message}`
            : runnerKind === "px4-runtime-replay"
              ? `The PX4 runtime replay runner failed: ${message}`
              : `The fake evidence runner failed: ${message}`;
    const cautions =
      runnerKind === "static-source-evidence"
        ? ["This is a static-source runner infrastructure failure, not firmware evidence."]
        : runnerKind === "mavlink-parser-fuzz"
          ? [
              "This is a parser-library runner infrastructure failure, not firmware evidence.",
              "This is not PX4 SITL evidence.",
            ]
          : runnerKind === "px4-sitl-probe"
            ? [
                "This is a PX4 SITL probe runner infrastructure failure, not runtime observation evidence.",
                "This does not prove firmware safety.",
              ]
            : runnerKind === "px4-runtime-replay"
              ? [
                  "This is a PX4 runtime replay runner infrastructure failure, not a runtime observation.",
                  "This does not prove firmware safety or vulnerability discovery.",
                ]
              : ["This is a fake runner infrastructure failure, not firmware evidence."];
    const result: EvidenceResult = {
      job_id: jobId,
      state: "failed",
      verdict: "runner_failed",
      confidence: "low",
      summary,
      evidence_signals: [],
      artifact_paths: [],
      cautions,
      completed_at: failedAt,
      runner_kind: runnerKind,
    };
    await writeJson(paths.resultPath, result);
    const finalStatus = await updateStatusUnlocked(jobId, {
      state: "failed",
      phase: "failed",
      progress: 100,
      finished_at: failedAt,
      message: result.summary,
    });
    if (finalStatus.state === "cancelled") {
      await writeJson(
        paths.resultPath,
        buildCancelledResult(jobId, finalStatus.finished_at ?? nowIso(), finalStatus.runner?.type),
      );
    }
    return finalStatus;
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function installRunnerSignalHandlers(
  jobId: string,
  options: { kindLabel: string; onAbort?: () => void } = { kindLabel: "fake runner" },
): void {
  let handlingSignal = false;
  const handleSignal = (signal: NodeJS.Signals) => {
    if (handlingSignal) {
      return;
    }
    handlingSignal = true;
    try {
      options.onAbort?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Abort hook failed for ${jobId}: ${message}\n`);
    }
    void completeCancelled(
      jobId,
      `Cancellation requested; standalone ${options.kindLabel} received ${signal}.`,
    )
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Failed to record cancellation for ${jobId}: ${message}\n`);
      })
      .finally(() => {
        process.exit(0);
      });
  };

  process.once("SIGTERM", handleSignal);
  process.once("SIGINT", handleSignal);
}

export async function runStandaloneFakeEvidenceJob(jobId: string): Promise<void> {
  assertSafeJobId(jobId);
  installRunnerSignalHandlers(jobId, { kindLabel: "fake runner" });
  try {
    if (await shouldStopRunner(jobId)) {
      return;
    }
    const startedStatus = await updateStatus(jobId, {
      state: "running",
      phase: "starting",
      progress: 5,
      started_at: nowIso(),
      message: "Standalone fake runner process started.",
    });
    if (terminal(startedStatus.state)) {
      return;
    }

    for (const step of FAKE_STEPS) {
      await delay(FAKE_STEP_DELAY_MS);
      if (await shouldStopRunner(jobId)) {
        return;
      }
      const stepStatus = await updateStatus(jobId, {
        state: "running",
        phase: step.phase,
        progress: step.progress,
        message: step.message,
      });
      if (terminal(stepStatus.state)) {
        return;
      }
    }

    if (await shouldStopRunner(jobId)) {
      return;
    }

    const completedAt = nowIso();
    const record = await readJobRecord(jobId);
    const result = buildEvidenceResult(record, completedAt);
    await completeWithResult(record, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await completeFailedJob(jobId, message);
  }
}

function staticSourceArtifactPaths(
  jobId: string,
  outcome: StaticSourceOutcome,
): string[] {
  const paths = jobPaths(jobId);
  const result: string[] = [
    relativeToRepo(join(paths.artifactDirAbs, "source-context.md")),
    relativeToRepo(join(paths.artifactDirAbs, "commit-info.json")),
  ];
  if (outcome.kind === "evidence") {
    if (outcome.evidence.artifacts.diff_patch !== undefined) {
      result.push(relativeToRepo(join(paths.artifactDirAbs, "diff.patch")));
    }
    if (outcome.evidence.artifacts.diff_summary_md !== undefined) {
      result.push(relativeToRepo(join(paths.artifactDirAbs, "diff-summary.md")));
    }
  } else {
    return [relativeToRepo(join(paths.artifactDirAbs, "failure.md"))];
  }
  return result;
}

async function writeStaticSourceArtifacts(
  jobId: string,
  outcome: StaticSourceOutcome,
): Promise<void> {
  const paths = jobPaths(jobId);
  await mkdir(paths.artifactDirAbs, { recursive: true });
  if (outcome.kind === "evidence") {
    const artifacts = outcome.evidence.artifacts;
    await writeFile(
      join(paths.artifactDirAbs, "source-context.md"),
      artifacts.source_context_md,
      "utf8",
    );
    await writeJson(join(paths.artifactDirAbs, "commit-info.json"), artifacts.commit_info);
    if (artifacts.diff_patch !== undefined) {
      await writeFile(
        join(paths.artifactDirAbs, "diff.patch"),
        artifacts.diff_patch.endsWith("\n") ? artifacts.diff_patch : `${artifacts.diff_patch}\n`,
        "utf8",
      );
    }
    if (artifacts.diff_summary_md !== undefined) {
      await writeFile(
        join(paths.artifactDirAbs, "diff-summary.md"),
        artifacts.diff_summary_md,
        "utf8",
      );
    }
  } else {
    await writeFile(
      join(paths.artifactDirAbs, "failure.md"),
      outcome.failure.failure_md,
      "utf8",
    );
  }
}

async function buildStaticSourceResult(
  record: JobRecord,
  outcome: StaticSourceOutcome,
  completedAt: string,
): Promise<EvidenceResult> {
  const artifactList = staticSourceArtifactPaths(record.job_id, outcome);
  const caseId = record.request.case_id;
  const testCardId = record.request.test_card_id;
  const targetCommit = record.request.target_commit;

  if (outcome.kind === "failure") {
    const failure = outcome.failure;
    const config = await loadStaticSourceConfig().catch(() => undefined);
    const caseConfig = config?.cases[caseId];
    return {
      job_id: record.job_id,
      state: "failed",
      verdict: "runner_failed",
      confidence: "low",
      summary: failure.summary,
      evidence_signals: [
        {
          name: "static_source_runner_outcome",
          value: failure.verdict_kind,
          interpretation:
            "Static-source runner could not produce evidence. The failure artifact records what was attempted.",
        },
      ],
      artifact_paths: artifactList,
      cautions: failure.caveats,
      completed_at: completedAt,
      runner_kind: "static-source-evidence",
      static_source: {
        case_id: caseId,
        test_card_id: testCardId,
        target_commit: targetCommit,
        resolved_commit_hash: failure.resolved_commit_hash ?? targetCommit,
        verdict_kind: failure.verdict_kind,
        target_file: caseConfig?.target_file ?? "(unresolved)",
        target_function: caseConfig?.target_function ?? "(unresolved)",
        pr_url: caseConfig?.pr_url ?? "(unresolved)",
        failure_stage: failure.stage,
      },
    };
  }

  const evidence = outcome.evidence;
  const verdict =
    evidence.verdict_kind === "static_evidence_consistent_with_claim"
      ? "mitigation_observed"
      : evidence.verdict_kind === "static_evidence_conflicts_with_claim"
        ? "attention_required"
        : "manual_review_needed";
  const confidence = evidence.verdict_kind === "static_evidence_inconclusive" ? "low" : "medium";

  const signals: EvidenceSignal[] = [
    {
      name: "static_source_verdict",
      value: evidence.verdict_kind,
      interpretation: evidence.summary,
    },
    {
      name: "resolved_commit",
      value: evidence.commit.hash,
      interpretation: `Static evidence is anchored at PX4 commit ${evidence.commit.hash}.`,
    },
  ];
  if (evidence.region) {
    signals.push({
      name: "target_source_region",
      value: `${evidence.region.file_path}:${evidence.region.start_line}-${evidence.region.end_line}`,
      interpretation: `Inspected ${evidence.region.function_name} at the resolved commit.`,
    });
  }
  if (evidence.resolved.pair && evidence.artifacts.diff_patch !== undefined) {
    signals.push({
      name: "diff_pair",
      value: `${evidence.resolved.pair.pre_hash.slice(0, 12)}..${evidence.resolved.pair.post_hash.slice(0, 12)}`,
      interpretation: "Diff between the pre-patch parent and the post-patch fix is captured in artifacts/diff.patch.",
    });
  }

  return {
    job_id: record.job_id,
    state: "succeeded",
    verdict,
    confidence,
    summary: evidence.summary,
    evidence_signals: signals,
    artifact_paths: artifactList,
    cautions: evidence.caveats,
    completed_at: completedAt,
    runner_kind: "static-source-evidence",
    static_source: {
      case_id: caseId,
      test_card_id: testCardId,
      target_commit: targetCommit,
      resolved_commit_hash: evidence.commit.hash,
      verdict_kind: evidence.verdict_kind,
      alias: evidence.resolved.alias,
      pair_alias:
        evidence.resolved.role === "pre-patch"
          ? evidence.resolved.pair?.post_alias
          : evidence.resolved.pair?.pre_alias,
      role: evidence.resolved.role,
      target_file: evidence.resolved.case_config.target_file,
      target_function: evidence.resolved.case_config.target_function,
      source_region: evidence.region
        ? { start_line: evidence.region.start_line, end_line: evidence.region.end_line }
        : undefined,
      diff_pre_hash: evidence.resolved.pair?.pre_hash,
      diff_post_hash: evidence.resolved.pair?.post_hash,
      diff_files_changed: evidence.diff_files_changed,
      pr_url: evidence.resolved.case_config.pr_url,
    },
  };
}

async function completeWithStaticSourceOutcome(
  record: JobRecord,
  outcome: StaticSourceOutcome,
): Promise<JobStatus> {
  return withJobLock(record.job_id, async () => {
    const current = await readStatus(record.job_id);
    if (terminal(current.state)) {
      return current;
    }
    await writeStaticSourceArtifacts(record.job_id, outcome);
    const beforeResult = await readStatus(record.job_id);
    if (terminal(beforeResult.state)) {
      return beforeResult;
    }
    const completedAt = nowIso();
    const result = await buildStaticSourceResult(record, outcome, completedAt);
    const paths = jobPaths(record.job_id);
    await writeJson(paths.resultPath, result);
    const finalStatus = await updateStatusUnlocked(record.job_id, {
      state: result.state,
      phase: result.state === "failed" ? "failed" : "complete",
      progress: 100,
      finished_at: result.completed_at,
      message:
        result.state === "failed"
          ? result.summary
          : "Static-source evidence job completed.",
    });
    if (finalStatus.state === "cancelled" && finalStatus.state !== result.state) {
      await writeJson(
        paths.resultPath,
        buildCancelledResult(record.job_id, finalStatus.finished_at ?? nowIso(), finalStatus.runner?.type),
      );
    }
    return finalStatus;
  });
}

// Cancellation note: the signal handler installed below writes the cancelled
// result.json and exits via process.exit(0). The main flow also aborts its
// in-flight git work via the AbortController. The completion path checks for
// a terminal state both before writing artifacts and before overwriting
// result.json, so a SIGTERM landing late in the work still leaves the job in
// `cancelled` rather than `failed` in the common case. A worst-case race
// (signal lands exactly between the final terminal check and the result write)
// remains documented as a PoC limitation, matching the fake runner's behavior.
export async function runStandaloneStaticSourceEvidenceJob(jobId: string): Promise<void> {
  assertSafeJobId(jobId);
  const controller = new AbortController();
  installRunnerSignalHandlers(jobId, {
    kindLabel: "static-source runner",
    onAbort: () => controller.abort(),
  });
  try {
    if (await shouldStopRunner(jobId)) {
      return;
    }
    const startedStatus = await updateStatus(jobId, {
      state: "running",
      phase: "starting",
      progress: 5,
      started_at: nowIso(),
      message: "Standalone static-source runner process started.",
    });
    if (terminal(startedStatus.state)) {
      return;
    }

    const record = await readJobRecord(jobId);
    const outcome = await produceStaticSourceEvidence({
      case_id: record.request.case_id,
      test_card_id: record.request.test_card_id,
      target_commit: record.request.target_commit,
      signal: controller.signal,
      onProgress: async (phase, progress, message) => {
        if (controller.signal.aborted) {
          return;
        }
        if (await shouldStopRunner(jobId)) {
          return;
        }
        await updateStatus(jobId, {
          state: "running",
          phase,
          progress,
          message,
        });
      },
    });

    if (await shouldStopRunner(jobId)) {
      return;
    }
    await completeWithStaticSourceOutcome(record, outcome);
  } catch (error) {
    if (controller.signal.aborted) {
      // Cancellation path already writes the cancelled result.
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    await completeFailedJob(jobId, message);
  }
}

function fuzzArtifactPaths(jobId: string, outcome: MavlinkParserFuzzOutcome): string[] {
  const paths = jobPaths(jobId);
  return mavlinkParserFuzzArtifactPaths(paths.artifactDirAbs, outcome).map(relativeToRepo);
}

async function buildMavlinkParserFuzzResult(
  record: JobRecord,
  outcome: MavlinkParserFuzzOutcome,
  completedAt: string,
): Promise<EvidenceResult> {
  const artifactList = fuzzArtifactPaths(record.job_id, outcome);
  const caseId = record.request.case_id;
  const testCardId = record.request.test_card_id;
  const targetCommit = record.request.target_commit;
  const budgetProfile = record.request.budget_profile;

  if (outcome.kind === "failure") {
    const failure = outcome.failure;
    return {
      job_id: record.job_id,
      state: "failed",
      verdict: "runner_failed",
      confidence: "low",
      summary: failure.summary,
      evidence_signals: [
        {
          name: "mavlink_parser_fuzz_runner_outcome",
          value: failure.stage,
          interpretation: "Parser fuzz runner could not complete a parser budget.",
        },
      ],
      artifact_paths: artifactList,
      cautions: failure.caveats,
      completed_at: completedAt,
      runner_kind: "mavlink-parser-fuzz",
      mavlink_parser_fuzz: {
        case_id: caseId,
        test_card_id: testCardId,
        target_commit: targetCommit,
        pymavlink_version: "unknown",
        python_version: "unknown",
        dialect: "unknown",
        message_family: "unknown",
        mutation_budget: 0,
        inputs_tried: 0,
        exceptions_found: 0,
        mutation_strategies: [],
        budget_profile: budgetProfile,
      },
    };
  }

  const evidence = outcome.evidence;
  const signals: EvidenceSignal[] = [
    {
      name: "parser_library",
      value: `pymavlink ${evidence.pymavlink_version}`,
      interpretation: "Parser-library fuzz used the pinned pymavlink version in the local venv.",
    },
    {
      name: "mutation_budget",
      value: evidence.mutation_budget,
      interpretation: `Budget profile ${budgetProfile} allowed ${evidence.mutation_budget} mutations.`,
    },
    {
      name: "inputs_tried",
      value: evidence.inputs_tried,
      interpretation: "Number of mutated MAVLink frames fed to the pymavlink decoder.",
    },
    {
      name: "parser_exceptions_found",
      value: evidence.exceptions_found,
      interpretation:
        evidence.exceptions_found > 0
          ? "At least one mutated input triggered a parser exception."
          : "No parser exceptions were observed under this budget.",
    },
    {
      name: "message_family",
      value: evidence.message_family,
      interpretation: `Seed corpus centered on ${evidence.message_family} in the ${evidence.dialect} dialect.`,
    },
  ];

  return {
    job_id: record.job_id,
    state: "succeeded",
    verdict: evidence.verdict,
    confidence: evidence.verdict === "attention_required" ? "medium" : "low",
    summary: evidence.summary,
    evidence_signals: signals,
    artifact_paths: artifactList,
    cautions: evidence.caveats,
    completed_at: completedAt,
    runner_kind: "mavlink-parser-fuzz",
    mavlink_parser_fuzz: {
      case_id: caseId,
      test_card_id: testCardId,
      target_commit: targetCommit,
      pymavlink_version: evidence.pymavlink_version,
      python_version: evidence.python_version,
      dialect: evidence.dialect,
      message_family: evidence.message_family,
      mutation_budget: evidence.mutation_budget,
      inputs_tried: evidence.inputs_tried,
      exceptions_found: evidence.exceptions_found,
      mutation_strategies: evidence.mutation_strategies,
      budget_profile: budgetProfile,
    },
  };
}

async function completeWithMavlinkParserFuzzOutcome(
  record: JobRecord,
  outcome: MavlinkParserFuzzOutcome,
): Promise<JobStatus> {
  return withJobLock(record.job_id, async () => {
    const current = await readStatus(record.job_id);
    if (terminal(current.state)) {
      return current;
    }
    const beforeResult = await readStatus(record.job_id);
    if (terminal(beforeResult.state)) {
      return beforeResult;
    }
    const completedAt = nowIso();
    const result = await buildMavlinkParserFuzzResult(record, outcome, completedAt);
    const paths = jobPaths(record.job_id);
    await writeJson(paths.resultPath, result);
    const finalStatus = await updateStatusUnlocked(record.job_id, {
      state: result.state,
      phase: result.state === "failed" ? "failed" : "complete",
      progress: 100,
      finished_at: result.completed_at,
      message:
        result.state === "failed"
          ? result.summary
          : "MAVLink parser fuzz evidence job completed.",
    });
    if (finalStatus.state === "cancelled" && finalStatus.state !== result.state) {
      await writeJson(
        paths.resultPath,
        buildCancelledResult(record.job_id, finalStatus.finished_at ?? nowIso(), finalStatus.runner?.type),
      );
    }
    return finalStatus;
  });
}

export async function runStandaloneMavlinkParserFuzzJob(jobId: string): Promise<void> {
  assertSafeJobId(jobId);
  const controller = new AbortController();
  installRunnerSignalHandlers(jobId, {
    kindLabel: "MAVLink parser fuzz runner",
    onAbort: () => controller.abort(),
  });
  try {
    if (await shouldStopRunner(jobId)) {
      return;
    }
    const startedStatus = await updateStatus(jobId, {
      state: "running",
      phase: "starting",
      progress: 5,
      started_at: nowIso(),
      message: "Standalone MAVLink parser fuzz runner process started.",
    });
    if (terminal(startedStatus.state)) {
      return;
    }

    const record = await readJobRecord(jobId);
    const paths = jobPaths(jobId);
    const outcome = await produceMavlinkParserFuzzEvidence({
      case_id: record.request.case_id,
      test_card_id: record.request.test_card_id,
      target_commit: record.request.target_commit,
      budget_profile: record.request.budget_profile,
      artifact_dir: paths.artifactDirAbs,
      signal: controller.signal,
      onProgress: async (phase, progress, message) => {
        if (controller.signal.aborted) {
          return;
        }
        if (await shouldStopRunner(jobId)) {
          return;
        }
        await updateStatus(jobId, {
          state: "running",
          phase,
          progress,
          message,
        });
      },
    });

    if (await shouldStopRunner(jobId)) {
      return;
    }
    await completeWithMavlinkParserFuzzOutcome(record, outcome);
  } catch (error) {
    if (controller.signal.aborted) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    await completeFailedJob(jobId, message);
  }
}

function probeArtifactPaths(jobId: string, outcome: Px4SitlProbeOutcome): string[] {
  const paths = jobPaths(jobId);
  return px4SitlProbeArtifactPaths(paths.artifactDirAbs, outcome).map(relativeToRepo);
}

async function buildPx4SitlProbeResult(
  record: JobRecord,
  outcome: Px4SitlProbeOutcome,
  completedAt: string,
): Promise<EvidenceResult> {
  const artifactList = probeArtifactPaths(record.job_id, outcome);
  const caseId = record.request.case_id;
  const testCardId = record.request.test_card_id;
  const targetCommit = record.request.target_commit;
  const budgetProfile = record.request.budget_profile;

  if (outcome.kind === "failure") {
    const failure = outcome.failure;
    return {
      job_id: record.job_id,
      state: "failed",
      verdict: "runner_failed",
      confidence: "low",
      summary: failure.summary,
      evidence_signals: [
        {
          name: "px4_sitl_probe_runner_outcome",
          value: failure.stage,
          interpretation: "PX4 SITL probe runner could not complete a runtime observation.",
        },
      ],
      artifact_paths: artifactList,
      cautions: failure.caveats,
      completed_at: completedAt,
      runner_kind: "px4-sitl-probe",
      px4_sitl_probe: {
        case_id: caseId,
        test_card_id: testCardId,
        target_commit: targetCommit,
        failure_stage: failure.stage,
        pymavlink_version: "unknown",
        python_version: "unknown",
        mavlink_connection: "unknown",
        heartbeat_observed: false,
        px4_binary_present: false,
        budget_profile: budgetProfile,
      },
    };
  }

  const evidence = outcome.evidence;
  const verdict =
    evidence.outcome === "runtime_observed"
      ? "manual_review_needed"
      : evidence.outcome === "runtime_abnormal"
        ? "attention_required"
        : "manual_review_needed";
  const confidence = evidence.outcome === "runtime_observed" ? "medium" : "low";

  const signals: EvidenceSignal[] = [
    {
      name: "px4_runtime_probe_outcome",
      value: evidence.outcome,
      interpretation: evidence.summary,
    },
    {
      name: "px4_sitl_binary_present",
      value: evidence.px4_binary_present,
      interpretation: evidence.px4_binary_present
        ? "A local PX4 SITL binary was available for the probe attempt."
        : "No local PX4 SITL binary was available; see preflight and setup artifacts.",
    },
    {
      name: "mavlink_heartbeat_observed",
      value: evidence.heartbeat_observed,
      interpretation: evidence.heartbeat_observed
        ? "The probe observed a live MAVLink heartbeat from the PX4 instance."
        : "No live MAVLink heartbeat was observed during the probe window.",
    },
    {
      name: "mavlink_connection",
      value: evidence.mavlink_connection,
      interpretation: "MAVLink connection string used for observation.",
    },
  ];

  return {
    job_id: record.job_id,
    state: "succeeded",
    verdict,
    confidence,
    summary: evidence.summary,
    evidence_signals: signals,
    artifact_paths: artifactList,
    cautions: evidence.caveats,
    completed_at: completedAt,
    runner_kind: "px4-sitl-probe",
    px4_sitl_probe: {
      case_id: caseId,
      test_card_id: testCardId,
      target_commit: targetCommit,
      outcome: evidence.outcome,
      pymavlink_version: evidence.pymavlink_version,
      python_version: evidence.python_version,
      mavlink_connection: evidence.mavlink_connection,
      heartbeat_observed: evidence.heartbeat_observed,
      px4_binary_present: evidence.px4_binary_present,
      budget_profile: budgetProfile,
    },
  };
}

async function completeWithPx4SitlProbeOutcome(
  record: JobRecord,
  outcome: Px4SitlProbeOutcome,
): Promise<JobStatus> {
  return withJobLock(record.job_id, async () => {
    const current = await readStatus(record.job_id);
    if (terminal(current.state)) {
      return current;
    }
    const beforeResult = await readStatus(record.job_id);
    if (terminal(beforeResult.state)) {
      return beforeResult;
    }
    const completedAt = nowIso();
    const result = await buildPx4SitlProbeResult(record, outcome, completedAt);
    const paths = jobPaths(record.job_id);
    await writeJson(paths.resultPath, result);
    const finalStatus = await updateStatusUnlocked(record.job_id, {
      state: result.state,
      phase: result.state === "failed" ? "failed" : "complete",
      progress: 100,
      finished_at: result.completed_at,
      message:
        result.state === "failed"
          ? result.summary
          : "PX4 SITL runtime probe evidence job completed.",
    });
    if (finalStatus.state === "cancelled" && finalStatus.state !== result.state) {
      await writeJson(
        paths.resultPath,
        buildCancelledResult(record.job_id, finalStatus.finished_at ?? nowIso(), finalStatus.runner?.type),
      );
    }
    return finalStatus;
  });
}

export async function runStandalonePx4SitlProbeJob(jobId: string): Promise<void> {
  assertSafeJobId(jobId);
  const controller = new AbortController();
  installRunnerSignalHandlers(jobId, {
    kindLabel: "PX4 SITL probe runner",
    onAbort: () => controller.abort(),
  });
  try {
    if (await shouldStopRunner(jobId)) {
      return;
    }
    const startedStatus = await updateStatus(jobId, {
      state: "running",
      phase: "starting",
      progress: 5,
      started_at: nowIso(),
      message: "Standalone PX4 SITL probe runner process started.",
    });
    if (terminal(startedStatus.state)) {
      return;
    }

    const record = await readJobRecord(jobId);
    const paths = jobPaths(jobId);
    const outcome = await producePx4SitlProbeEvidence({
      case_id: record.request.case_id,
      test_card_id: record.request.test_card_id,
      target_commit: record.request.target_commit,
      budget_profile: record.request.budget_profile,
      artifact_dir: paths.artifactDirAbs,
      signal: controller.signal,
      onProgress: async (phase, progress, message) => {
        if (controller.signal.aborted) {
          return;
        }
        if (await shouldStopRunner(jobId)) {
          return;
        }
        await updateStatus(jobId, {
          state: "running",
          phase,
          progress,
          message,
        });
      },
    });

    if (await shouldStopRunner(jobId)) {
      return;
    }
    await completeWithPx4SitlProbeOutcome(record, outcome);
  } catch (error) {
    if (controller.signal.aborted) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    await completeFailedJob(jobId, message);
  }
}

function replayArtifactPaths(jobId: string, outcome: Px4RuntimeReplayOutcome): string[] {
  const paths = jobPaths(jobId);
  return px4RuntimeReplayArtifactPaths(paths.artifactDirAbs, outcome).map(relativeToRepo);
}

async function buildPx4RuntimeReplayResult(
  record: JobRecord,
  outcome: Px4RuntimeReplayOutcome,
  completedAt: string,
): Promise<EvidenceResult> {
  const artifactList = replayArtifactPaths(record.job_id, outcome);
  const caseId = record.request.case_id;
  const testCardId = record.request.test_card_id;
  const targetCommit = record.request.target_commit;
  const budgetProfile = record.request.budget_profile;

  if (outcome.kind === "failure") {
    const failure = outcome.failure;
    return {
      job_id: record.job_id,
      state: "failed",
      verdict: "runner_failed",
      confidence: "low",
      summary: failure.summary,
      evidence_signals: [
        {
          name: "px4_runtime_replay_runner_outcome",
          value: failure.stage,
          interpretation: "PX4 runtime replay runner could not complete a frame delivery observation.",
        },
      ],
      artifact_paths: artifactList,
      cautions: failure.caveats,
      completed_at: completedAt,
      runner_kind: "px4-runtime-replay",
      px4_runtime_replay: {
        case_id: caseId,
        test_card_id: testCardId,
        target_commit: targetCommit,
        resolved_commit_hash: "unknown",
        failure_stage: failure.stage,
        pymavlink_version: "unknown",
        python_version: "unknown",
        mavlink_connection: "unknown",
        frame_delivered: false,
        firmware_commit_proven: false,
        px4_binary_present: false,
        budget_profile: budgetProfile,
        sanitizers_used: [],
        sanitizer_findings: [],
      },
    };
  }

  const evidence = outcome.evidence;
  const verdict =
    evidence.outcome === "runtime_clean"
      ? "manual_review_needed"
      : evidence.outcome === "runtime_anomalous"
        ? "attention_required"
        : "manual_review_needed";
  const confidence = evidence.outcome === "runtime_clean" ? "medium" : "low";

  const signals: EvidenceSignal[] = [
    {
      name: "px4_runtime_replay_outcome",
      value: evidence.outcome,
      interpretation: evidence.summary,
    },
    {
      name: "px4_resolved_commit_hash",
      value: evidence.resolved_commit_hash,
      interpretation: "Resolved commit hash recorded for this replay job.",
    },
    {
      name: "crafted_frame_delivered",
      value: evidence.frame_delivered,
      interpretation: evidence.frame_delivered
        ? "The harness sent the crafted BATTERY_STATUS frame to PX4."
        : "The crafted frame was not delivered; see delivery-record.json.",
    },
    {
      name: "px4_sitl_binary_present",
      value: evidence.px4_binary_present,
      interpretation: evidence.px4_binary_present
        ? "A local PX4 SITL binary file was present during the replay attempt."
        : "No local PX4 SITL binary file was present; see preflight and setup artifacts.",
    },
    {
      name: "firmware_commit_proven",
      value: evidence.firmware_commit_proven,
      interpretation: evidence.firmware_commit_proven
        ? "A build manifest or fresh build proves the executed SITL binary matches the resolved commit."
        : "The runner did not execute firmware with verified commit provenance.",
    },
    {
      name: "mavlink_connection",
      value: evidence.mavlink_connection,
      interpretation: "MAVLink connection string used for frame delivery.",
    },
  ];

  return {
    job_id: record.job_id,
    state: "succeeded",
    verdict,
    confidence,
    summary: evidence.summary,
    evidence_signals: signals,
    artifact_paths: artifactList,
    cautions: evidence.caveats,
    completed_at: completedAt,
    runner_kind: "px4-runtime-replay",
    px4_runtime_replay: {
      case_id: caseId,
      test_card_id: testCardId,
      target_commit: targetCommit,
      resolved_commit_hash: evidence.resolved_commit_hash,
      outcome: evidence.outcome,
      pymavlink_version: evidence.pymavlink_version,
      python_version: evidence.python_version,
      mavlink_connection: evidence.mavlink_connection,
      frame_delivered: evidence.frame_delivered,
      firmware_commit_proven: evidence.firmware_commit_proven,
      px4_binary_present: evidence.px4_binary_present,
      budget_profile: budgetProfile,
      build_method: evidence.build_method,
      binary_path: evidence.px4_binary_path,
      sanitizers_used: evidence.sanitizers_used,
      sanitizer_findings: evidence.sanitizer_findings,
    },
  };
}

async function completeWithPx4RuntimeReplayOutcome(
  record: JobRecord,
  outcome: Px4RuntimeReplayOutcome,
): Promise<JobStatus> {
  return withJobLock(record.job_id, async () => {
    const current = await readStatus(record.job_id);
    if (terminal(current.state)) {
      return current;
    }
    const beforeResult = await readStatus(record.job_id);
    if (terminal(beforeResult.state)) {
      return beforeResult;
    }
    const completedAt = nowIso();
    const result = await buildPx4RuntimeReplayResult(record, outcome, completedAt);
    const paths = jobPaths(record.job_id);
    await writeJson(paths.resultPath, result);
    const finalStatus = await updateStatusUnlocked(record.job_id, {
      state: result.state,
      phase: result.state === "failed" ? "failed" : "complete",
      progress: 100,
      finished_at: result.completed_at,
      message:
        result.state === "failed"
          ? result.summary
          : "PX4 BATTERY_STATUS runtime replay evidence job completed.",
    });
    if (finalStatus.state === "cancelled" && finalStatus.state !== result.state) {
      await writeJson(
        paths.resultPath,
        buildCancelledResult(record.job_id, finalStatus.finished_at ?? nowIso(), finalStatus.runner?.type),
      );
    }
    return finalStatus;
  });
}

export async function runStandalonePx4RuntimeReplayJob(jobId: string): Promise<void> {
  assertSafeJobId(jobId);
  const controller = new AbortController();
  installRunnerSignalHandlers(jobId, {
    kindLabel: "PX4 runtime replay runner",
    onAbort: () => controller.abort(),
  });
  try {
    if (await shouldStopRunner(jobId)) {
      return;
    }
    const startedStatus = await updateStatus(jobId, {
      state: "running",
      phase: "starting",
      progress: 5,
      started_at: nowIso(),
      message: "Standalone PX4 runtime replay runner process started.",
    });
    if (terminal(startedStatus.state)) {
      return;
    }

    const record = await readJobRecord(jobId);
    const paths = jobPaths(jobId);
    const outcome = await producePx4RuntimeReplayEvidence({
      case_id: record.request.case_id,
      test_card_id: record.request.test_card_id,
      target_commit: record.request.target_commit,
      budget_profile: record.request.budget_profile,
      artifact_dir: paths.artifactDirAbs,
      signal: controller.signal,
      onProgress: async (phase, progress, message) => {
        if (controller.signal.aborted) {
          return;
        }
        if (await shouldStopRunner(jobId)) {
          return;
        }
        await updateStatus(jobId, {
          state: "running",
          phase,
          progress,
          message,
        });
      },
    });

    if (await shouldStopRunner(jobId)) {
      return;
    }
    await completeWithPx4RuntimeReplayOutcome(record, outcome);
  } catch (error) {
    if (controller.signal.aborted) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    await completeFailedJob(jobId, message);
  }
}

function runnerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "TMPDIR", "TEMP", "TMP", "NODE_ENV"] as const) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }
  env.NODE_ENV ??= "test";
  return env;
}

interface RunnerLaunchPlan {
  kind: RunnerKind;
  entrypoint: string;
  scriptPath: string;
  expectedDurationMs: number;
}

function chooseRunnerLaunchPlan(
  caseId: string,
  staticConfig: StaticSourceConfig,
  fuzzConfig: MavlinkParserFuzzConfig,
  probeConfig: Px4SitlProbeConfig,
  replayConfig: Px4RuntimeReplayConfig,
): RunnerLaunchPlan {
  if (Object.prototype.hasOwnProperty.call(staticConfig.cases, caseId)) {
    return {
      kind: "static-source-evidence",
      entrypoint: STATIC_SOURCE_RUNNER_ENTRYPOINT,
      scriptPath: STATIC_SOURCE_RUNNER_SCRIPT_PATH,
      expectedDurationMs: STATIC_SOURCE_EXPECTED_DURATION_MS,
    };
  }
  if (Object.prototype.hasOwnProperty.call(replayConfig.cases, caseId)) {
    return {
      kind: "px4-runtime-replay",
      entrypoint: PX4_RUNTIME_REPLAY_RUNNER_ENTRYPOINT,
      scriptPath: PX4_RUNTIME_REPLAY_RUNNER_SCRIPT_PATH,
      expectedDurationMs: PX4_RUNTIME_REPLAY_EXPECTED_DURATION_MS,
    };
  }
  if (Object.prototype.hasOwnProperty.call(probeConfig.cases, caseId)) {
    return {
      kind: "px4-sitl-probe",
      entrypoint: PX4_SITL_PROBE_RUNNER_ENTRYPOINT,
      scriptPath: PX4_SITL_PROBE_RUNNER_SCRIPT_PATH,
      expectedDurationMs: PX4_SITL_PROBE_EXPECTED_DURATION_MS,
    };
  }
  if (Object.prototype.hasOwnProperty.call(fuzzConfig.cases, caseId)) {
    return {
      kind: "mavlink-parser-fuzz",
      entrypoint: MAVLINK_PARSER_FUZZ_RUNNER_ENTRYPOINT,
      scriptPath: MAVLINK_PARSER_FUZZ_RUNNER_SCRIPT_PATH,
      expectedDurationMs: MAVLINK_PARSER_FUZZ_EXPECTED_DURATION_MS,
    };
  }
  return {
    kind: "fake-smoke",
    entrypoint: FAKE_RUNNER_ENTRYPOINT,
    scriptPath: FAKE_RUNNER_SCRIPT_PATH,
    expectedDurationMs: FAKE_STEP_DELAY_MS * FAKE_STEPS.length,
  };
}

function launchStandaloneRunner(jobId: string, plan: RunnerLaunchPlan): JobRunnerProcessMetadata {
  const runnerArgs = ["--import", "tsx", plan.scriptPath, jobId];
  const child = spawn(process.execPath, runnerArgs, {
    cwd: REPO_ROOT,
    detached: true,
    env: runnerEnvironment(),
    stdio: "ignore",
  });

  if (!child.pid) {
    throw new Error(`Standalone runner process did not report a pid (kind=${plan.kind}).`);
  }

  child.unref();
  return {
    pid: child.pid,
    launched_at: nowIso(),
    entrypoint: plan.entrypoint,
    detached: true,
    cancel_signal: RUNNER_CANCEL_SIGNAL,
  };
}

async function writeRunnerProcessMetadata(
  status: JobStatus,
  runner: JobRunnerMetadata,
): Promise<JobStatus> {
  return withJobLock(status.job_id, async () => {
    const current = await readStatus(status.job_id).catch(() => status);
    const updated: JobStatus = {
      ...current,
      runner,
      updated_at: nowIso(),
    };
    await writeStatus(updated);
    return updated;
  });
}

interface RunnerSignalResult {
  outcome: "sent" | "missing_process_metadata" | "already_exited" | "signal_failed";
  message: string;
}

function signalRunnerProcess(status: JobStatus): RunnerSignalResult {
  const pid = status.runner?.process?.pid;
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    return {
      outcome: "missing_process_metadata",
      message: "Cancellation requested; no standalone runner pid was recorded.",
    };
  }

  const runnerLabel =
    status.runner?.type === "static-source-evidence"
      ? "static-source runner"
      : status.runner?.type === "mavlink-parser-fuzz"
        ? "MAVLink parser fuzz runner"
        : status.runner?.type === "px4-sitl-probe"
          ? "PX4 SITL probe runner"
          : status.runner?.type === "px4-runtime-replay"
            ? "PX4 runtime replay runner"
            : "fake runner";
  try {
    process.kill(pid, RUNNER_CANCEL_SIGNAL);
    return {
      outcome: "sent",
      message: `Cancellation requested; sent ${RUNNER_CANCEL_SIGNAL} to standalone ${runnerLabel} pid ${pid}.`,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return {
        outcome: "already_exited",
        message: `Cancellation requested; standalone ${runnerLabel} process was already gone.`,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      outcome: "signal_failed",
      message: `Cancellation requested; failed to signal standalone ${runnerLabel}: ${message}`,
    };
  }
}

export async function launchEvidenceJob(params: LaunchEvidenceJobInput): Promise<JobLaunchDetails> {
  if (!params.target_commit.trim()) {
    throw new Error("target_commit must be a non-empty string.");
  }

  const [resolvedCase, resolvedTestCard, staticConfig, fuzzConfig, probeConfig, replayConfig] =
    await Promise.all([
    loadCase(params.case_id),
    loadTestCard(params.test_card_id),
    loadStaticSourceConfig(),
    loadMavlinkParserFuzzConfig(),
    loadPx4SitlProbeConfig(),
    loadPx4RuntimeReplayConfig(),
  ]);
  const plan = chooseRunnerLaunchPlan(
    params.case_id,
    staticConfig,
    fuzzConfig,
    probeConfig,
    replayConfig,
  );
  if (plan.kind === "px4-runtime-replay") {
    validatePx4RuntimeReplayTarget(params.target_commit, replayConfig, staticConfig);
  }
  const jobId = createJobId();
  const paths = jobPaths(jobId);
  const launchedAt = nowIso();
  const request: Required<LaunchEvidenceJobInput> = {
    case_id: params.case_id,
    test_card_id: params.test_card_id,
    target_commit: params.target_commit,
    budget_profile: params.budget_profile ?? "smoke-fast",
  };
  const record: JobRecord = {
    job_id: jobId,
    launched_at: launchedAt,
    request,
    resolved_case: resolvedCase,
    resolved_test_card: resolvedTestCard,
    runner: {
      type: plan.kind,
      expected_duration_ms: plan.expectedDurationMs,
    },
  };
  const queueMessage =
    plan.kind === "static-source-evidence"
      ? "Static-source evidence job queued."
      : plan.kind === "mavlink-parser-fuzz"
        ? "MAVLink parser fuzz evidence job queued."
        : plan.kind === "px4-sitl-probe"
          ? "PX4 SITL runtime probe evidence job queued."
          : plan.kind === "px4-runtime-replay"
            ? "PX4 BATTERY_STATUS runtime replay evidence job queued."
            : "Fake evidence job queued.";
  const status: JobStatus = {
    job_id: jobId,
    state: "queued",
    phase: "queued",
    progress: 0,
    created_at: launchedAt,
    updated_at: launchedAt,
    run_dir: paths.runDir,
    artifact_dir: paths.artifactDir,
    runner: record.runner,
    message: queueMessage,
  };

  await mkdir(paths.artifactDirAbs, { recursive: true });
  await writeJson(paths.jobPath, record);
  await writeStatus(status);
  await appendEvent(jobId, {
    timestamp: launchedAt,
    state: status.state,
    phase: status.phase,
    progress: status.progress,
    message: status.message,
  });

  const runnerProcess = launchStandaloneRunner(jobId, plan);
  const runner = {
    ...record.runner,
    process: runnerProcess,
  };
  await writeRunnerProcessMetadata(status, runner);

  return {
    job_id: jobId,
    state: status.state,
    phase: status.phase,
    progress: status.progress,
    run_dir: status.run_dir,
    artifact_dir: status.artifact_dir,
    runner,
  };
}

export async function inspectJob(params: InspectJobInput): Promise<JobInspectionDetails> {
  const status = await readStatus(params.job_id);
  const recentEvents = await readRecentEvents(params.job_id);
  const result = await readResultIfPresent(params.job_id);
  return {
    job_id: status.job_id,
    state: status.state,
    phase: status.phase,
    progress: status.progress,
    run_dir: status.run_dir,
    artifact_dir: status.artifact_dir,
    recent_events: recentEvents,
    result,
    artifact_paths: result?.artifact_paths,
    runner: status.runner,
    message: status.message,
  };
}

export async function cancelJob(params: CancelJobInput): Promise<JobCancellationDetails> {
  const status = await readStatus(params.job_id);
  if (terminal(status.state)) {
    const inspected = await inspectJob(params);
    return {
      ...inspected,
      cancel_action: "already_terminal",
      message: `Job is already terminal: ${status.state}.`,
    };
  }

  const signalResult = signalRunnerProcess(status);
  const cancellationStatus = await completeCancelled(params.job_id, signalResult.message);
  const inspected = await inspectJob(params);
  const cancelAction = cancellationStatus.state === "cancelled" ? "cancelled" : "already_terminal";
  return {
    ...inspected,
    cancel_action: cancelAction,
    message: cancelAction === "cancelled" ? inspected.message : `Job is already terminal: ${cancellationStatus.state}.`,
  };
}

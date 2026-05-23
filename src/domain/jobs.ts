import { mkdir, readFile, writeFile, appendFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadCase, loadTestCard, type CuratedCase, type TestCard } from "./catalog.js";

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
}

export interface JobLaunchDetails {
  job_id: string;
  state: JobState;
  phase: string;
  progress: number;
  run_dir: string;
  artifact_dir: string;
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
  runner: {
    type: "fake-smoke";
    expected_duration_ms: number;
  };
}

interface ActiveJobHandle {
  cancelRequested: boolean;
}

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RUNS_ROOT = join(REPO_ROOT, "runs");
const FAKE_STEP_DELAY_MS = 250;
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

const activeJobs = new Map<string, ActiveJobHandle>();
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
    return await action();
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
    };
  }

  if (caseId === "mavlink-battery-status-bounds" && targetCommit.includes("pre-patch-demo")) {
    return {
      job_id: record.job_id,
      state: "succeeded",
      verdict: "attention_required",
      confidence: "medium",
      summary: "The fake parser-bounds smoke found malformed battery/status frames that still reached the field-copy stage in the pre-patch demo target.",
      evidence_signals: [
        {
          name: "malformed_frame_rejection",
          value: false,
          interpretation: "Pre-patch demo evidence is shaped to show the bounds fix is not present.",
        },
        {
          name: "normal_frame_compatibility",
          value: true,
          interpretation: "Normal BATTERY_STATUS traffic still passes in the fake replay.",
        },
      ],
      artifact_paths: artifacts,
      cautions: ["Fake runner only; do not treat this as PX4/SITL evidence."],
      completed_at: completedAt,
    };
  }

  if (caseId === "mavlink-battery-status-bounds" && targetCommit.includes("post-patch-demo")) {
    return {
      job_id: record.job_id,
      state: "succeeded",
      verdict: "mitigation_observed",
      confidence: "medium",
      summary: "The fake parser-bounds smoke shows malformed battery/status frames rejected before field copy while normal frames still pass in the post-patch demo target.",
      evidence_signals: [
        {
          name: "malformed_frame_rejection",
          value: true,
          interpretation: "Post-patch demo evidence is shaped to show the bounds fix is present.",
        },
        {
          name: "normal_frame_compatibility",
          value: true,
          interpretation: "Normal BATTERY_STATUS traffic still passes in the fake replay.",
        },
      ],
      artifact_paths: artifacts,
      cautions: ["Fake runner only; do not treat this as PX4/SITL evidence."],
      completed_at: completedAt,
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

async function completeCancelled(jobId: string): Promise<JobStatus> {
  return withJobLock(jobId, async () => {
    const current = await readStatus(jobId);
    if (terminal(current.state)) {
      return current;
    }
    const active = activeJobs.get(jobId);
    if (active) {
      active.cancelRequested = true;
    }
    const completedAt = nowIso();
    const result: EvidenceResult = {
      job_id: jobId,
      state: "cancelled",
      verdict: "cancelled",
      confidence: "low",
      summary: "The fake evidence job was cancelled before it produced evidence.",
      evidence_signals: [],
      artifact_paths: [],
      cautions: ["No evidence conclusion is available for a cancelled job."],
      completed_at: completedAt,
    };
    const paths = jobPaths(jobId);
    await writeJson(paths.resultPath, result);
    return updateStatusUnlocked(jobId, {
      state: "cancelled",
      phase: "cancelled",
      finished_at: completedAt,
      cancelled_at: completedAt,
      message: "Cancellation requested; fake runner stopped before completion.",
    });
  });
}

async function isCancelled(jobId: string, handle: ActiveJobHandle): Promise<boolean> {
  if (handle.cancelRequested) {
    await completeCancelled(jobId);
    return true;
  }
  const status = await readStatus(jobId);
  return status.state === "cancelled";
}

async function completeWithResult(record: JobRecord, result: EvidenceResult): Promise<JobStatus> {
  return withJobLock(record.job_id, async () => {
    const current = await readStatus(record.job_id);
    if (terminal(current.state)) {
      return current;
    }
    await writeArtifacts(record, result);
    const paths = jobPaths(record.job_id);
    await writeJson(paths.resultPath, result);
    return updateStatusUnlocked(record.job_id, {
      state: result.state,
      phase: result.state === "failed" ? "failed" : "complete",
      progress: 100,
      finished_at: result.completed_at,
      message: result.state === "failed" ? result.summary : "Fake evidence job completed successfully.",
    });
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
    const result: EvidenceResult = {
      job_id: jobId,
      state: "failed",
      verdict: "runner_failed",
      confidence: "low",
      summary: `The fake evidence runner failed: ${message}`,
      evidence_signals: [],
      artifact_paths: [],
      cautions: ["This is a fake runner infrastructure failure, not firmware evidence."],
      completed_at: failedAt,
    };
    await writeJson(paths.resultPath, result);
    return updateStatusUnlocked(jobId, {
      state: "failed",
      phase: "failed",
      progress: 100,
      finished_at: failedAt,
      message: result.summary,
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runFakeJob(jobId: string, handle: ActiveJobHandle): Promise<void> {
  try {
    if (await isCancelled(jobId, handle)) {
      return;
    }
    await updateStatus(jobId, {
      state: "running",
      phase: "starting",
      progress: 5,
      started_at: nowIso(),
      message: "Fake runner started.",
    });

    for (const step of FAKE_STEPS) {
      await delay(FAKE_STEP_DELAY_MS);
      if (await isCancelled(jobId, handle)) {
        return;
      }
      await updateStatus(jobId, {
        state: "running",
        phase: step.phase,
        progress: step.progress,
        message: step.message,
      });
    }

    if (await isCancelled(jobId, handle)) {
      return;
    }

    const completedAt = nowIso();
    const record = await readJobRecord(jobId);
    const result = buildEvidenceResult(record, completedAt);
    await completeWithResult(record, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await completeFailedJob(jobId, message);
  } finally {
    activeJobs.delete(jobId);
  }
}

export async function launchEvidenceJob(params: LaunchEvidenceJobInput): Promise<JobLaunchDetails> {
  if (!params.target_commit.trim()) {
    throw new Error("target_commit must be a non-empty string.");
  }

  const [resolvedCase, resolvedTestCard] = await Promise.all([
    loadCase(params.case_id),
    loadTestCard(params.test_card_id),
  ]);
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
      type: "fake-smoke",
      expected_duration_ms: FAKE_STEP_DELAY_MS * FAKE_STEPS.length,
    },
  };
  const status: JobStatus = {
    job_id: jobId,
    state: "queued",
    phase: "queued",
    progress: 0,
    created_at: launchedAt,
    updated_at: launchedAt,
    run_dir: paths.runDir,
    artifact_dir: paths.artifactDir,
    message: "Fake evidence job queued.",
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

  const handle: ActiveJobHandle = { cancelRequested: false };
  activeJobs.set(jobId, handle);
  setTimeout(() => {
    void runFakeJob(jobId, handle);
  }, 0);

  return {
    job_id: jobId,
    state: status.state,
    phase: status.phase,
    progress: status.progress,
    run_dir: status.run_dir,
    artifact_dir: status.artifact_dir,
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

  const cancellationStatus = await completeCancelled(params.job_id);
  const inspected = await inspectJob(params);
  const cancelAction = cancellationStatus.state === "cancelled" ? "cancelled" : "already_terminal";
  return {
    ...inspected,
    cancel_action: cancelAction,
    message: cancelAction === "cancelled" ? inspected.message : `Job is already terminal: ${cancellationStatus.state}.`,
  };
}

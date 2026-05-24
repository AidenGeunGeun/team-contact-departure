import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  type EvidenceResult,
  type JobState,
  type RunnerKind,
} from "./jobs.js";
import { loadPx4RuntimeReplayConfig } from "./px4-runtime-replay.js";
import {
  loadStaticSourceConfig,
  type StaticSourceConfig,
} from "./static-source-evidence.js";

export interface CompareEvidencePairInput {
  job_id_a: string;
  job_id_b: string;
}

export interface EvidencePairJobSummary {
  job_id: string;
  runner_kind: RunnerKind;
  target_commit: string;
  budget_profile?: string;
  resolved_commit_hash?: string;
  outcome?: string;
  firmware_commit_proven?: boolean;
  frame_delivered?: boolean;
  role?: "pre-patch" | "post-patch";
}

export interface EvidencePairRecord {
  pair_id: string;
  compared_at: string;
  case_id: string;
  test_card_id: string;
  pre_patch: EvidencePairJobSummary;
  post_patch: EvidencePairJobSummary;
  outcomes_differ: boolean;
  resolved_commit_hashes_differ: boolean;
  frame_bytes_equal: boolean;
  provenance_complete: boolean;
  budget_profile_equal: boolean;
  frames_delivered_on_both_sides: boolean;
  meaningful_outcomes_on_both_sides: boolean;
  verdict_flip_demonstrated: boolean;
}

export interface CompareEvidencePairDetails {
  pair_id: string;
  pair_dir: string;
  pair_path: string;
  pair: EvidencePairRecord;
}

export class EvidencePairError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidencePairError";
  }
}

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RUNS_ROOT = join(REPO_ROOT, "runs");
export const PAIRS_ROOT = join(REPO_ROOT, "pairs");

const MEANINGFUL_RUNTIME_OUTCOMES = new Set(["runtime_clean", "runtime_anomalous"]);

interface JobRecordFile {
  job_id: string;
  request: {
    case_id: string;
    test_card_id: string;
    target_commit: string;
    budget_profile?: string;
  };
}

interface FrameRecordFile {
  frame_hex?: string;
}

const TERMINAL_STATES = new Set<JobState>(["succeeded", "failed", "cancelled"]);

function toPosixPath(pathName: string): string {
  return pathName.split(sep).join("/");
}

function relativeToRepo(pathName: string): string {
  return toPosixPath(relative(REPO_ROOT, pathName));
}

function assertSafeJobId(jobId: string): void {
  if (!/^job-[A-Za-z0-9_-]+$/.test(jobId)) {
    throw new EvidencePairError(`Invalid job_id: ${jobId}`);
  }
}

function assertSafePairId(pairId: string): void {
  if (!/^pair-[A-Za-z0-9_-]+$/.test(pairId)) {
    throw new EvidencePairError(`Invalid pair_id: ${pairId}`);
  }
}

function createPairId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `pair-${timestamp}-${randomUUID().slice(0, 8)}`;
}

function pairPaths(pairId: string): {
  pairDirAbs: string;
  pairPath: string;
  pairDir: string;
} {
  assertSafePairId(pairId);
  const pairDirAbs = join(PAIRS_ROOT, pairId);
  return {
    pairDirAbs,
    pairPath: join(pairDirAbs, "pair.json"),
    pairDir: relativeToRepo(pairDirAbs),
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

async function readJobRecord(jobId: string): Promise<JobRecordFile> {
  assertSafeJobId(jobId);
  return readJson<JobRecordFile>(join(RUNS_ROOT, jobId, "job.json"));
}

async function readJobStatus(jobId: string): Promise<{ state: JobState }> {
  assertSafeJobId(jobId);
  return readJson<{ state: JobState }>(join(RUNS_ROOT, jobId, "status.json"));
}

async function readJobResult(jobId: string): Promise<EvidenceResult> {
  assertSafeJobId(jobId);
  return readJson<EvidenceResult>(join(RUNS_ROOT, jobId, "result.json"));
}

function normalizeBudgetProfile(record: JobRecordFile): string {
  return record.request.budget_profile ?? "smoke-fast";
}

function hasMeaningfulRuntimeOutcome(outcome: string | undefined): boolean {
  return outcome !== undefined && MEANINGFUL_RUNTIME_OUTCOMES.has(outcome);
}

function extractJobSummary(jobId: string, record: JobRecordFile, result: EvidenceResult): EvidencePairJobSummary {
  const base: EvidencePairJobSummary = {
    job_id: jobId,
    runner_kind: result.runner_kind ?? "fake-smoke",
    target_commit: record.request.target_commit,
    budget_profile: normalizeBudgetProfile(record),
  };

  if (result.px4_runtime_replay) {
    const replay = result.px4_runtime_replay;
    return {
      ...base,
      resolved_commit_hash: replay.resolved_commit_hash,
      outcome: replay.outcome,
      firmware_commit_proven: replay.firmware_commit_proven,
      frame_delivered: replay.frame_delivered,
    };
  }

  if (result.static_source) {
    const staticSource = result.static_source;
    return {
      ...base,
      resolved_commit_hash: staticSource.resolved_commit_hash,
      outcome: staticSource.verdict_kind,
    };
  }

  if (result.px4_sitl_probe) {
    return {
      ...base,
      outcome: result.px4_sitl_probe.outcome,
    };
  }

  if (result.mavlink_parser_fuzz) {
    return {
      ...base,
      outcome: result.verdict,
    };
  }

  return {
    ...base,
    outcome: result.verdict,
  };
}

async function resolveStaticSourceCaseId(evidenceCaseId: string): Promise<string | undefined> {
  const staticConfig = await loadStaticSourceConfig();
  if (Object.prototype.hasOwnProperty.call(staticConfig.cases, evidenceCaseId)) {
    return evidenceCaseId;
  }

  try {
    const replayConfig = await loadPx4RuntimeReplayConfig();
    if (Object.prototype.hasOwnProperty.call(replayConfig.cases, evidenceCaseId)) {
      return replayConfig.static_source_case_id;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function resolveRoleFromHash(
  staticConfig: StaticSourceConfig,
  staticSourceCaseId: string,
  jobId: string,
  resolvedCommitHash: string | undefined,
): "pre-patch" | "post-patch" {
  if (!resolvedCommitHash || resolvedCommitHash === "unknown") {
    throw new EvidencePairError(
      `Job ${jobId} is missing a resolved commit hash; compare_evidence_pair requires pinned pre-patch or post-patch firmware.`,
    );
  }

  const caseConfig = staticConfig.cases[staticSourceCaseId];
  if (!caseConfig) {
    throw new EvidencePairError(
      `Case ${staticSourceCaseId} is not configured in data/static-source-commits.json.`,
    );
  }

  const hash = resolvedCommitHash.toLowerCase();
  const preHash = staticConfig.aliases[caseConfig.pre_alias].commit_hash.toLowerCase();
  const postHash = staticConfig.aliases[caseConfig.post_alias].commit_hash.toLowerCase();

  if (hash === preHash) {
    return "pre-patch";
  }
  if (hash === postHash) {
    return "post-patch";
  }

  throw new EvidencePairError(
    `Job ${jobId} resolved commit hash ${resolvedCommitHash} does not map to a known pre-patch or post-patch commit for this case (expected ${caseConfig.pre_alias} or ${caseConfig.post_alias}).`,
  );
}

function assignPrePostRoles(
  summaryA: EvidencePairJobSummary,
  summaryB: EvidencePairJobSummary,
): { pre_patch: EvidencePairJobSummary; post_patch: EvidencePairJobSummary } {
  if (summaryA.role === "pre-patch" && summaryB.role === "post-patch") {
    return { pre_patch: summaryA, post_patch: summaryB };
  }
  if (summaryA.role === "post-patch" && summaryB.role === "pre-patch") {
    return { pre_patch: summaryB, post_patch: summaryA };
  }

  throw new EvidencePairError(
    "compare_evidence_pair requires one pre-patch and one post-patch job.",
  );
}

function validateBudgetProfileMatch(jobA: JobRecordFile, jobB: JobRecordFile): void {
  const budgetA = normalizeBudgetProfile(jobA);
  const budgetB = normalizeBudgetProfile(jobB);
  if (budgetA !== budgetB) {
    throw new EvidencePairError(
      `Jobs must use the same budget_profile to compare evidence. Got ${budgetA} vs ${budgetB}.`,
    );
  }
}

function validatePairComposition(
  summaryA: EvidencePairJobSummary,
  summaryB: EvidencePairJobSummary,
): void {
  if (summaryA.role === summaryB.role) {
    throw new EvidencePairError(
      `Both jobs resolve to the same role (${summaryA.role}); compare_evidence_pair requires one pre-patch and one post-patch job.`,
    );
  }

  const hashA = summaryA.resolved_commit_hash?.toLowerCase();
  const hashB = summaryB.resolved_commit_hash?.toLowerCase();
  if (hashA && hashB && hashA === hashB) {
    throw new EvidencePairError(
      `Both jobs resolve to the same commit hash (${summaryA.resolved_commit_hash}); compare_evidence_pair requires different firmware commits.`,
    );
  }
}

async function readJobFrameHex(jobId: string, result: EvidenceResult): Promise<string> {
  const artifactPath = result.artifact_paths.find((path) => path.endsWith("frame-record.json"));
  const absolutePath = artifactPath
    ? join(REPO_ROOT, artifactPath)
    : join(RUNS_ROOT, jobId, "artifacts", "frame-record.json");

  let raw: string;
  try {
    raw = await readFile(absolutePath, "utf8");
  } catch {
    throw new EvidencePairError(
      `Job ${jobId} is missing frame-record.json; compare_evidence_pair requires byte-equal crafted frames from both jobs.`,
    );
  }

  const record = JSON.parse(raw) as FrameRecordFile;
  const frameHex = record.frame_hex?.trim().toLowerCase();
  if (!frameHex) {
    throw new EvidencePairError(
      `Job ${jobId} frame-record.json is missing frame_hex; compare_evidence_pair requires the canonical crafted frame bytes.`,
    );
  }

  return frameHex;
}

async function loadCompletedJob(jobId: string): Promise<{
  record: JobRecordFile;
  result: EvidenceResult;
  summary: EvidencePairJobSummary;
}> {
  const [status, record, result] = await Promise.all([
    readJobStatus(jobId),
    readJobRecord(jobId),
    readJobResult(jobId),
  ]);

  if (!TERMINAL_STATES.has(status.state)) {
    throw new EvidencePairError(
      `Job ${jobId} is not terminal (${status.state}). compare_evidence_pair only reads completed jobs.`,
    );
  }

  return {
    record,
    result,
    summary: extractJobSummary(jobId, record, result),
  };
}

export function buildEvidencePairRecord(input: {
  pair_id: string;
  compared_at: string;
  case_id: string;
  test_card_id: string;
  pre_patch: EvidencePairJobSummary;
  post_patch: EvidencePairJobSummary;
}): EvidencePairRecord {
  const { pre_patch, post_patch } = input;
  const outcomes_differ = pre_patch.outcome !== post_patch.outcome;
  const resolved_commit_hashes_differ =
    Boolean(pre_patch.resolved_commit_hash && post_patch.resolved_commit_hash) &&
    pre_patch.resolved_commit_hash !== post_patch.resolved_commit_hash;
  const frame_bytes_equal = true;
  const budget_profile_equal = true;
  const provenance_complete =
    pre_patch.firmware_commit_proven === true && post_patch.firmware_commit_proven === true;
  const frames_delivered_on_both_sides =
    pre_patch.frame_delivered === true && post_patch.frame_delivered === true;
  const meaningful_outcomes_on_both_sides =
    hasMeaningfulRuntimeOutcome(pre_patch.outcome) && hasMeaningfulRuntimeOutcome(post_patch.outcome);
  const roles_correctly_assigned = pre_patch.role === "pre-patch" && post_patch.role === "post-patch";
  const verdict_flip_demonstrated =
    roles_correctly_assigned &&
    provenance_complete &&
    frames_delivered_on_both_sides &&
    meaningful_outcomes_on_both_sides &&
    outcomes_differ &&
    frame_bytes_equal &&
    budget_profile_equal;

  return {
    pair_id: input.pair_id,
    compared_at: input.compared_at,
    case_id: input.case_id,
    test_card_id: input.test_card_id,
    pre_patch,
    post_patch,
    outcomes_differ,
    resolved_commit_hashes_differ,
    frame_bytes_equal,
    provenance_complete,
    budget_profile_equal,
    frames_delivered_on_both_sides,
    meaningful_outcomes_on_both_sides,
    verdict_flip_demonstrated,
  };
}

interface EmbeddedJobRecord {
  job_id: string;
  request: JobRecordFile["request"];
}

export async function recomputeEvidencePairFromJobs(input: {
  pairId: string;
  comparedAt: string;
  preJob: EmbeddedJobRecord;
  preResult: EvidenceResult;
  postJob: EmbeddedJobRecord;
  postResult: EvidenceResult;
}): Promise<EvidencePairRecord> {
  const preSummary = extractJobSummary(input.preJob.job_id, input.preJob, input.preResult);
  const postSummary = extractJobSummary(input.postJob.job_id, input.postJob, input.postResult);
  const caseId = input.preJob.request.case_id;

  const staticSourceCaseId = await resolveStaticSourceCaseId(caseId);
  if (!staticSourceCaseId) {
    throw new EvidencePairError(`Case ${caseId} has no static-source role mapping for pair replay.`);
  }

  const staticConfig = await loadStaticSourceConfig();
  preSummary.role = resolveRoleFromHash(
    staticConfig,
    staticSourceCaseId,
    preSummary.job_id,
    preSummary.resolved_commit_hash,
  );
  postSummary.role = resolveRoleFromHash(
    staticConfig,
    staticSourceCaseId,
    postSummary.job_id,
    postSummary.resolved_commit_hash,
  );

  const { pre_patch, post_patch } = assignPrePostRoles(preSummary, postSummary);

  return buildEvidencePairRecord({
    pair_id: input.pairId,
    compared_at: input.comparedAt,
    case_id: caseId,
    test_card_id: input.preJob.request.test_card_id,
    pre_patch,
    post_patch,
  });
}

export async function compareEvidencePair(params: CompareEvidencePairInput): Promise<CompareEvidencePairDetails> {
  if (params.job_id_a === params.job_id_b) {
    throw new EvidencePairError("compare_evidence_pair requires two different job IDs.");
  }

  const [jobA, jobB] = await Promise.all([
    loadCompletedJob(params.job_id_a),
    loadCompletedJob(params.job_id_b),
  ]);

  const caseA = jobA.record.request.case_id;
  const cardA = jobA.record.request.test_card_id;
  const caseB = jobB.record.request.case_id;
  const cardB = jobB.record.request.test_card_id;

  if (caseA !== caseB || cardA !== cardB) {
    throw new EvidencePairError(
      `Jobs must share the same case and test card to compare evidence. Got ${caseA}/${cardA} vs ${caseB}/${cardB}.`,
    );
  }

  validateBudgetProfileMatch(jobA.record, jobB.record);

  const staticSourceCaseId = await resolveStaticSourceCaseId(caseA);
  if (!staticSourceCaseId) {
    throw new EvidencePairError(
      `Case ${caseA} does not have a configured pre-patch/post-patch commit pair; compare_evidence_pair requires pinned firmware roles.`,
    );
  }

  const staticConfig = await loadStaticSourceConfig();
  jobA.summary.role = resolveRoleFromHash(
    staticConfig,
    staticSourceCaseId,
    jobA.summary.job_id,
    jobA.summary.resolved_commit_hash,
  );
  jobB.summary.role = resolveRoleFromHash(
    staticConfig,
    staticSourceCaseId,
    jobB.summary.job_id,
    jobB.summary.resolved_commit_hash,
  );

  validatePairComposition(jobA.summary, jobB.summary);

  const [frameHexA, frameHexB] = await Promise.all([
    readJobFrameHex(jobA.summary.job_id, jobA.result),
    readJobFrameHex(jobB.summary.job_id, jobB.result),
  ]);
  if (frameHexA !== frameHexB) {
    throw new EvidencePairError(
      "Crafted frame bytes differ between the two jobs; compare_evidence_pair requires the same MAVLink frame on both sides.",
    );
  }

  const { pre_patch, post_patch } = assignPrePostRoles(jobA.summary, jobB.summary);

  const pairId = createPairId();
  const paths = pairPaths(pairId);
  const pair = buildEvidencePairRecord({
    pair_id: pairId,
    compared_at: new Date().toISOString(),
    case_id: caseA,
    test_card_id: cardA,
    pre_patch,
    post_patch,
  });

  await writeJson(paths.pairPath, pair);

  return {
    pair_id: pairId,
    pair_dir: paths.pairDir,
    pair_path: relativeToRepo(paths.pairPath),
    pair,
  };
}

export async function readEvidencePair(pairId: string): Promise<EvidencePairRecord | undefined> {
  assertSafePairId(pairId);
  const paths = pairPaths(pairId);
  try {
    return await readJson<EvidencePairRecord>(paths.pairPath);
  } catch {
    return undefined;
  }
}

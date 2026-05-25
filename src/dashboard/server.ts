import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type EvidenceResult, type JobEvent, type JobState, type JobStatus } from "../domain/jobs.js";
import { type EvidencePairRecord } from "../domain/evidence-pair.js";
import { BUNDLES_ROOT } from "../domain/evidence-bundle.js";
import type { BundleManifest } from "../replay/types.js";
import { operatorDemoPrompt, operatorSessionManager } from "../operator/session-manager.js";
import { AGENT_AUTH_INSTRUCTION } from "../agent/run.js";

interface DashboardJobRecord {
  job_id?: unknown;
  launched_at?: unknown;
  request?: {
    case_id?: unknown;
    test_card_id?: unknown;
    target_commit?: unknown;
    budget_profile?: unknown;
  };
  resolved_case?: {
    id?: unknown;
    title?: unknown;
    short_description?: unknown;
  };
  resolved_test_card?: {
    id?: unknown;
    title?: unknown;
  };
  runner?: {
    type?: unknown;
    expected_duration_ms?: unknown;
  };
}

interface ArtifactMetadata {
  name: string;
  size: number;
  type: "json" | "diff" | "markdown" | "csv" | "text";
  updated_at: string;
}

interface ReadProblem {
  file: string;
  message: string;
  missing?: boolean;
}

interface JobSnapshot {
  job_id: string;
  case_id?: string;
  case_title?: string;
  test_card_id?: string;
  test_card_title?: string;
  target_commit?: string;
  state: JobState | "unknown";
  phase: string;
  progress: number;
  runner_kind?: string;
  verdict?: string;
  verdict_kind?: string;
  resolved_commit_hash?: string;
  created_at?: string;
  updated_at?: string;
  artifact_count: number;
  has_errors: boolean;
  errors: ReadProblem[];
}

interface JobDetail extends JobSnapshot {
  request?: DashboardJobRecord["request"];
  resolved_case?: DashboardJobRecord["resolved_case"];
  resolved_test_card?: DashboardJobRecord["resolved_test_card"];
  status?: JobStatus;
  result?: EvidenceResult;
  recent_events: JobEvent[];
  artifacts: ArtifactMetadata[];
}

interface PairSnapshot {
  pair_id: string;
  case_id: string;
  test_card_id: string;
  compared_at: string;
  outcomes_differ: boolean;
  resolved_commit_hashes_differ: boolean;
  verdict_flip_demonstrated: boolean;
  pre_patch_job_id: string;
  post_patch_job_id: string;
}

interface PairDetail extends PairSnapshot {
  pair: EvidencePairRecord;
  pre_patch_job?: JobSnapshot;
  post_patch_job?: JobSnapshot;
}

interface BundleSnapshot {
  bundle_id: string;
  created_at: string;
  runner_kind: string;
  replay_kind: string;
  case_id: string;
  test_card_id: string;
  job_id?: string;
  pair_id?: string;
  recorded_verdict: string;
}

interface BundleDetail extends BundleSnapshot {
  manifest: BundleManifest;
  artifact_paths: string[];
  replay_command: string;
}

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RUNS_ROOT = join(REPO_ROOT, "runs");
const PAIRS_ROOT = join(REPO_ROOT, "pairs");
const BUNDLES_DIR = BUNDLES_ROOT;
const STATIC_ROOT = fileURLToPath(new URL("./static/", import.meta.url));
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4108;
const MAX_ARTIFACT_BYTES = 1_000_000;

const STATIC_MIME_TYPES = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"],
]);

function nowIso(): string {
  return new Date().toISOString();
}

function toPosixPath(pathName: string): string {
  return pathName.split(sep).join("/");
}

function isSafeJobId(jobId: string): boolean {
  return /^job-[A-Za-z0-9_-]+$/.test(jobId);
}

function isSafePairId(pairId: string): boolean {
  return /^pair-[A-Za-z0-9_-]+$/.test(pairId);
}

function isSafeBundleId(bundleId: string): boolean {
  return /^bundle-[A-Za-z0-9_-]+$/.test(bundleId);
}

function isTerminal(state: string | undefined): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function artifactType(name: string): ArtifactMetadata["type"] {
  const lower = name.toLowerCase();
  if (lower.endsWith(".json")) {
    return "json";
  }
  if (lower.endsWith(".patch") || lower.endsWith(".diff")) {
    return "diff";
  }
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) {
    return "markdown";
  }
  if (lower.endsWith(".csv")) {
    return "csv";
  }
  return "text";
}

async function pathExists(pathName: string): Promise<boolean> {
  try {
    await access(pathName);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(pathName: string): Promise<{ value?: T; error?: ReadProblem }> {
  try {
    const raw = await readFile(pathName, "utf8");
    return { value: JSON.parse(raw) as T };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        error: { file: toPosixPath(relative(REPO_ROOT, pathName)), message: "File is not present yet.", missing: true },
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { error: { file: toPosixPath(relative(REPO_ROOT, pathName)), message } };
  }
}

async function readEvents(jobId: string): Promise<{ events: JobEvent[]; error?: ReadProblem }> {
  const eventsPath = join(RUNS_ROOT, jobId, "events.jsonl");
  try {
    const raw = await readFile(eventsPath, "utf8");
    const events: JobEvent[] = [];
    for (const [index, line] of raw.split("\n").entries()) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        events.push(JSON.parse(trimmed) as JobEvent);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          events,
          error: {
            file: toPosixPath(relative(REPO_ROOT, eventsPath)),
            message: `Line ${index + 1} could not be parsed: ${message}`,
          },
        };
      }
    }
    return { events };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { events: [] };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      events: [],
      error: { file: toPosixPath(relative(REPO_ROOT, eventsPath)), message },
    };
  }
}

async function listArtifacts(jobId: string): Promise<ArtifactMetadata[]> {
  const artifactsRoot = join(RUNS_ROOT, jobId, "artifacts");
  let entries;
  try {
    entries = await readdir(artifactsRoot, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const artifacts: ArtifactMetadata[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const fileStat = await stat(join(artifactsRoot, entry.name));
    artifacts.push({
      name: entry.name,
      size: fileStat.size,
      type: artifactType(entry.name),
      updated_at: fileStat.mtime.toISOString(),
    });
  }
  return artifacts.sort((a, b) => a.name.localeCompare(b.name));
}

function safeArtifactPath(jobId: string, artifactName: string): string | undefined {
  if (!isSafeJobId(jobId) || artifactName.length === 0 || artifactName.includes("/") || artifactName.includes("\\")) {
    return undefined;
  }
  const artifactsRoot = resolve(RUNS_ROOT, jobId, "artifacts");
  const candidate = resolve(artifactsRoot, artifactName);
  const relativePath = relative(artifactsRoot, candidate);
  if (relativePath.startsWith("..") || relativePath === "" || relativePath.includes(sep)) {
    return undefined;
  }
  return candidate;
}

function buildSnapshot(
  jobId: string,
  record: DashboardJobRecord | undefined,
  status: JobStatus | undefined,
  result: EvidenceResult | undefined,
  artifacts: ArtifactMetadata[],
  errors: ReadProblem[],
): JobSnapshot {
  const request = record?.request;
  const state = status?.state ?? result?.state ?? "unknown";
  return {
    job_id: jobId,
    case_id: asString(request?.case_id) ?? result?.static_source?.case_id,
    case_title: asString(record?.resolved_case?.title),
    test_card_id: asString(request?.test_card_id) ?? result?.static_source?.test_card_id,
    test_card_title: asString(record?.resolved_test_card?.title),
    target_commit: asString(request?.target_commit) ?? result?.static_source?.target_commit,
    state,
    phase: status?.phase ?? "unknown",
    progress: Math.max(0, Math.min(100, asNumber(status?.progress, 0))),
    runner_kind: status?.runner?.type ?? result?.runner_kind ?? asString(record?.runner?.type),
    verdict: result?.verdict,
    verdict_kind:
      result?.static_source?.verdict_kind ??
      result?.px4_runtime_replay?.outcome ??
      result?.px4_sitl_probe?.outcome,
    resolved_commit_hash:
      result?.static_source?.resolved_commit_hash ?? result?.px4_runtime_replay?.resolved_commit_hash,
    created_at: status?.created_at ?? asString(record?.launched_at),
    updated_at: status?.updated_at ?? result?.completed_at ?? asString(record?.launched_at),
    artifact_count: artifacts.length,
    has_errors: errors.length > 0,
    errors,
  };
}

async function readJobDetail(jobId: string): Promise<JobDetail | undefined> {
  if (!isSafeJobId(jobId)) {
    return undefined;
  }
  const runDir = join(RUNS_ROOT, jobId);
  if (!(await pathExists(runDir))) {
    return undefined;
  }

  const [recordRead, statusRead, resultRead, eventsRead] = await Promise.all([
    readJsonFile<DashboardJobRecord>(join(runDir, "job.json")),
    readJsonFile<JobStatus>(join(runDir, "status.json")),
    readJsonFile<EvidenceResult>(join(runDir, "result.json")),
    readEvents(jobId),
  ]);
  let artifactError: ReadProblem | undefined;
  const artifacts = await listArtifacts(jobId).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    artifactError = { file: `runs/${jobId}/artifacts`, message };
    return [];
  });
  const collected = [recordRead.error, statusRead.error, resultRead.error, eventsRead.error, artifactError];
  const errors = collected.filter((item): item is ReadProblem => {
    if (!item) {
      return false;
    }
    if (item === resultRead.error && item.missing && !isTerminal(statusRead.value?.state)) {
      return false;
    }
    return true;
  });
  const snapshot = buildSnapshot(jobId, recordRead.value, statusRead.value, resultRead.value, artifacts, errors);
  return {
    ...snapshot,
    request: recordRead.value?.request,
    resolved_case: recordRead.value?.resolved_case,
    resolved_test_card: recordRead.value?.resolved_test_card,
    status: statusRead.value,
    result: resultRead.value,
    recent_events: eventsRead.events.slice(-10),
    artifacts,
  };
}

async function listJobs(): Promise<JobSnapshot[]> {
  let entries;
  try {
    entries = await readdir(RUNS_ROOT, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const jobs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && isSafeJobId(entry.name))
      .map(async (entry) => readJobDetail(entry.name)),
  );
  return jobs
    .filter((job): job is JobDetail => Boolean(job))
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
}

async function readPairDetail(pairId: string): Promise<PairDetail | undefined> {
  if (!isSafePairId(pairId)) {
    return undefined;
  }
  const pairDir = join(PAIRS_ROOT, pairId);
  if (!(await pathExists(pairDir))) {
    return undefined;
  }

  const pairRead = await readJsonFile<EvidencePairRecord>(join(pairDir, "pair.json"));
  if (!pairRead.value) {
    return undefined;
  }

  const pair = pairRead.value;
  const [prePatchJob, postPatchJob] = await Promise.all([
    readJobDetail(pair.pre_patch.job_id),
    readJobDetail(pair.post_patch.job_id),
  ]);

  return {
    pair_id: pair.pair_id,
    case_id: pair.case_id,
    test_card_id: pair.test_card_id,
    compared_at: pair.compared_at,
    outcomes_differ: pair.outcomes_differ,
    resolved_commit_hashes_differ: pair.resolved_commit_hashes_differ,
    verdict_flip_demonstrated: pair.verdict_flip_demonstrated,
    pre_patch_job_id: pair.pre_patch.job_id,
    post_patch_job_id: pair.post_patch.job_id,
    pair,
    pre_patch_job: prePatchJob,
    post_patch_job: postPatchJob,
  };
}

async function readBundleDetail(bundleId: string): Promise<BundleDetail | undefined> {
  if (!isSafeBundleId(bundleId)) {
    return undefined;
  }
  const bundleDir = join(BUNDLES_DIR, bundleId);
  if (!(await pathExists(bundleDir))) {
    return undefined;
  }
  const manifestRead = await readJsonFile<BundleManifest>(join(bundleDir, "manifest.json"));
  if (!manifestRead.value) {
    return undefined;
  }
  const manifest = manifestRead.value;
  return {
    bundle_id: manifest.bundle_id,
    created_at: manifest.created_at,
    runner_kind: manifest.runner_kind,
    replay_kind: manifest.replay_kind,
    case_id: manifest.case_id,
    test_card_id: manifest.test_card_id,
    job_id: manifest.job_id,
    pair_id: manifest.pair_id,
    recorded_verdict: manifest.recorded_result.verdict,
    manifest,
    artifact_paths: manifest.artifact_paths,
    replay_command: manifest.replay_command,
  };
}

async function listBundles(): Promise<BundleSnapshot[]> {
  let entries;
  try {
    entries = await readdir(BUNDLES_DIR, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const bundles = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && isSafeBundleId(entry.name))
      .map(async (entry) => readBundleDetail(entry.name)),
  );

  return bundles
    .filter((bundle): bundle is BundleDetail => Boolean(bundle))
    .map((bundle) => ({
      bundle_id: bundle.bundle_id,
      created_at: bundle.created_at,
      runner_kind: bundle.runner_kind,
      replay_kind: bundle.replay_kind,
      case_id: bundle.case_id,
      test_card_id: bundle.test_card_id,
      job_id: bundle.job_id,
      pair_id: bundle.pair_id,
      recorded_verdict: bundle.recorded_verdict,
    }))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

async function listPairs(): Promise<PairSnapshot[]> {
  let entries;
  try {
    entries = await readdir(PAIRS_ROOT, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const pairs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && isSafePairId(entry.name))
      .map(async (entry) => readPairDetail(entry.name)),
  );

  return pairs
    .filter((pair): pair is PairDetail => Boolean(pair))
    .map((pair) => ({
      pair_id: pair.pair_id,
      case_id: pair.case_id,
      test_card_id: pair.test_card_id,
      compared_at: pair.compared_at,
      outcomes_differ: pair.outcomes_differ,
      resolved_commit_hashes_differ: pair.resolved_commit_hashes_differ,
      verdict_flip_demonstrated: pair.pair.verdict_flip_demonstrated,
      pre_patch_job_id: pair.pre_patch_job_id,
      post_patch_job_id: pair.post_patch_job_id,
    }))
    .sort((a, b) => b.compared_at.localeCompare(a.compared_at));
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function sendArtifactText(response: ServerResponse, artifact: ArtifactMetadata, value: string): void {
  response.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-artifact-name": artifact.name,
    "x-artifact-type": artifact.type,
    "x-artifact-size": String(artifact.size),
  });
  response.end(value);
}

function sendNotFound(response: ServerResponse): void {
  sendJson(response, 404, { error: "not_found" });
}

function sendMethodNotAllowed(response: ServerResponse, allow = "GET"): void {
  response.writeHead(405, { allow, "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify({ error: "method_not_allowed" })}\n`);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw) as unknown;
}

async function serveStatic(requestPath: string, response: ServerResponse): Promise<void> {
  const fileName = requestPath === "/" ? "index.html" : decodeURIComponent(requestPath.slice(1));
  const candidate = resolve(STATIC_ROOT, fileName);
  const relativePath = relative(STATIC_ROOT, candidate);
  if (relativePath.startsWith("..") || relativePath === "" || relativePath.includes("..")) {
    sendNotFound(response);
    return;
  }

  const fileStat = await stat(candidate).catch(() => undefined);
  if (!fileStat?.isFile()) {
    sendNotFound(response);
    return;
  }
  const mimeType = STATIC_MIME_TYPES.get(extname(candidate)) ?? "text/plain; charset=utf-8";
  response.writeHead(200, { "content-type": mimeType, "cache-control": "no-store" });
  createReadStream(candidate).pipe(response);
}

async function handleOperatorApi(
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
): Promise<void> {
  const isSafeSessionId = (value: string): boolean => /^[0-9a-fA-F-]{36}$/.test(value) || value === "operator-smoke-stub";
  const isSafeJobId = (value: string): boolean => /^job-[0-9A-Za-z_-]+$/.test(value);
  if (url.pathname === "/api/operator/config" && request.method === "GET") {
    sendJson(response, 200, {
      product_name: "Contact Departure",
      demo_prompt: operatorDemoPrompt(),
      auth_recovery: AGENT_AUTH_INSTRUCTION,
      stop_available: true,
    });
    return;
  }

  if (url.pathname === "/api/operator/state" && request.method === "GET") {
    sendJson(response, 200, { state: operatorSessionManager.getState() });
    return;
  }

  if (url.pathname === "/api/operator/events" && request.method === "GET") {
    operatorSessionManager.subscribe(response);
    return;
  }

  if (url.pathname === "/api/operator/prompt" && request.method === "POST") {
    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch {
      sendJson(response, 400, { error: "invalid_json" });
      return;
    }
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const prompt = typeof record.prompt === "string" ? record.prompt : "";
    const stub = record.stub === true || process.env.CONTACT_OPERATOR_SMOKE_STUB === "1";
    const fresh = record.fresh === true;
    const result = await operatorSessionManager.submitPrompt(prompt, { stub, fresh });
    if (!result.accepted) {
      sendJson(response, 409, { error: result.reason ?? "not_accepted", state: operatorSessionManager.getState() });
      return;
    }
    sendJson(response, 202, { accepted: true, state: operatorSessionManager.getState() });
    return;
  }

  if (url.pathname === "/api/operator/sessions" && request.method === "GET") {
    sendJson(response, 200, {
      sessions: operatorSessionManager.listSessions(),
      state: operatorSessionManager.getState(),
    });
    return;
  }

  const sessionEventsMatch = url.pathname.match(/^\/api\/operator\/sessions\/([^/]+)\/events$/);
  if (sessionEventsMatch && request.method === "GET") {
    const sessionId = decodeURIComponent(sessionEventsMatch[1] ?? "");
    if (!isSafeSessionId(sessionId)) {
      sendJson(response, 400, { error: "invalid_session_id" });
      return;
    }
    sendJson(response, 200, {
      session_id: sessionId,
      events: operatorSessionManager.getSessionEvents(sessionId),
    });
    return;
  }

  const sessionDeleteMatch = url.pathname.match(/^\/api\/operator\/sessions\/([^/]+)$/);
  if (sessionDeleteMatch && request.method === "DELETE") {
    const sessionId = decodeURIComponent(sessionDeleteMatch[1] ?? "");
    if (!isSafeSessionId(sessionId)) {
      sendJson(response, 400, { error: "invalid_session_id" });
      return;
    }
    const result = operatorSessionManager.deleteSession(sessionId);
    if (!result.deleted) {
      const status = result.reason === "session_busy" ? 409 : 404;
      sendJson(response, status, {
        error: result.reason ?? "not_deleted",
        state: operatorSessionManager.getState(),
      });
      return;
    }
    sendJson(response, 200, {
      deleted: true,
      session_id: sessionId,
      state: operatorSessionManager.getState(),
    });
    return;
  }

  if (url.pathname === "/api/operator/new-session" && request.method === "POST") {
    if (operatorSessionManager.isBusy()) {
      sendJson(response, 409, { error: "session_busy", state: operatorSessionManager.getState() });
      return;
    }
    sendJson(response, 200, { state: operatorSessionManager.startNewChat() });
    return;
  }

  if (url.pathname === "/api/operator/stop" && request.method === "POST") {
    const result = await operatorSessionManager.abortSession();
    if (!result.aborted) {
      sendJson(response, 409, { error: result.reason ?? "not_running", state: operatorSessionManager.getState() });
      return;
    }
    sendJson(response, 200, { aborted: true, state: operatorSessionManager.getState() });
    return;
  }

  if (url.pathname === "/api/operator/select-job" && request.method === "POST") {
    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch {
      sendJson(response, 400, { error: "invalid_json" });
      return;
    }
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const jobId = typeof record.job_id === "string" ? record.job_id : undefined;
    if (jobId !== undefined && !isSafeJobId(jobId)) {
      sendJson(response, 400, { error: "invalid_job_id" });
      return;
    }
    operatorSessionManager.selectJob(jobId);
    sendJson(response, 200, { ok: true, state: operatorSessionManager.getState() });
    return;
  }

  sendNotFound(response);
}

async function handleApi(request: IncomingMessage, url: URL, response: ServerResponse): Promise<void> {
  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (url.pathname === "/api/health") {
    const runsAvailable = await pathExists(RUNS_ROOT);
    sendJson(response, 200, {
      ok: true,
      runs_dir: RUNS_ROOT,
      runs_available: runsAvailable,
      read_only: true,
      operator: true,
      operator_state: operatorSessionManager.getState().phase,
    });
    return;
  }

  if (url.pathname === "/api/jobs") {
    sendJson(response, 200, { jobs: await listJobs() });
    return;
  }

  if (url.pathname === "/api/pairs") {
    sendJson(response, 200, { pairs: await listPairs() });
    return;
  }

  if (url.pathname === "/api/bundles") {
    sendJson(response, 200, { bundles: await listBundles() });
    return;
  }

  if (segments[0] === "api" && segments[1] === "bundles" && segments[2]) {
    const bundleId = segments[2];
    if (!isSafeBundleId(bundleId)) {
      sendJson(response, 400, { error: "invalid_bundle_id" });
      return;
    }
    const detail = await readBundleDetail(bundleId);
    if (!detail) {
      sendNotFound(response);
      return;
    }
    sendJson(response, 200, detail);
    return;
  }

  if (segments[0] === "api" && segments[1] === "pairs" && segments[2]) {
    const pairId = segments[2];
    if (!isSafePairId(pairId)) {
      sendJson(response, 400, { error: "invalid_pair_id" });
      return;
    }
    const detail = await readPairDetail(pairId);
    if (!detail) {
      sendNotFound(response);
      return;
    }
    sendJson(response, 200, detail);
    return;
  }

  if (segments[0] !== "api" || segments[1] !== "jobs" || !segments[2]) {
    sendNotFound(response);
    return;
  }

  const jobId = segments[2];
  if (!isSafeJobId(jobId)) {
    sendJson(response, 400, { error: "invalid_job_id" });
    return;
  }

  if (segments.length === 3) {
    const detail = await readJobDetail(jobId);
    if (!detail) {
      sendNotFound(response);
      return;
    }
    sendJson(response, 200, detail);
    return;
  }

  if (segments.length === 4 && segments[3] === "events") {
    const detail = await readJobDetail(jobId);
    if (!detail) {
      sendNotFound(response);
      return;
    }
    sendJson(response, 200, { job_id: jobId, events: (await readEvents(jobId)).events });
    return;
  }

  if (segments.length === 4 && segments[3] === "artifacts") {
    const detail = await readJobDetail(jobId);
    if (!detail) {
      sendNotFound(response);
      return;
    }
    sendJson(response, 200, { job_id: jobId, artifacts: detail.artifacts });
    return;
  }

  if (segments.length === 5 && segments[3] === "artifacts") {
    const artifactPath = safeArtifactPath(jobId, segments[4]);
    if (!artifactPath) {
      sendJson(response, 400, { error: "invalid_artifact_name" });
      return;
    }
    const fileStat = await stat(artifactPath).catch(() => undefined);
    if (!fileStat?.isFile()) {
      sendNotFound(response);
      return;
    }
    if (fileStat.size > MAX_ARTIFACT_BYTES) {
      sendJson(response, 413, { error: "artifact_too_large", max_bytes: MAX_ARTIFACT_BYTES });
      return;
    }
    const text = await readFile(artifactPath, "utf8");
    sendArtifactText(response, {
      name: segments[4],
      size: fileStat.size,
      type: artifactType(segments[4]),
      updated_at: fileStat.mtime.toISOString(),
    }, text);
    return;
  }

  sendNotFound(response);
}

async function requestHandler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${DEFAULT_HOST}:${DEFAULT_PORT}`}`);
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }

    if (url.pathname.startsWith("/api/operator/")) {
      if (request.method !== "GET" && request.method !== "POST" && request.method !== "DELETE") {
        sendMethodNotAllowed(response, "GET, POST, DELETE");
        return;
      }
      await handleOperatorApi(request, url, response);
      return;
    }

    if (request.method !== "GET") {
      sendMethodNotAllowed(response);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, url, response);
      return;
    }
    await serveStatic(url.pathname, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, 500, { error: "dashboard_server_error", message });
  }
}

export function startDashboardServer(options: { port?: number; host?: string } = {}) {
  const host = options.host ?? process.env.DASHBOARD_HOST ?? DEFAULT_HOST;
  const port = options.port ?? Number(process.env.DASHBOARD_PORT ?? DEFAULT_PORT);
  const server = createServer((request, response) => {
    void requestHandler(request, response);
  });
  return new Promise<{ server: ReturnType<typeof createServer>; url: string }>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      const resolvedPort = typeof address === "object" && address ? address.port : port;
      resolvePromise({ server, url: `http://${host}:${resolvedPort}` });
    });
  });
}

async function main(): Promise<void> {
  const { url } = await startDashboardServer();
  console.log(`Contact Departure operator UI: ${url}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}

import { strict as assert } from "node:assert";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { startDashboardServer } from "../src/dashboard/server.js";
import { launchEvidenceJob } from "../src/domain/jobs.js";

interface JobSnapshot {
  job_id: string;
  state: string;
  runner_kind?: string;
  artifact_count: number;
}

interface ArtifactMetadata {
  name: string;
  size: number;
  type: "json" | "diff" | "markdown" | "csv" | "text";
  updated_at: string;
}

interface JobDetail extends JobSnapshot {
  status?: unknown;
  result?: unknown;
  request?: unknown;
  recent_events: unknown[];
  artifacts: ArtifactMetadata[];
}

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const RUNS_ROOT = new URL("../runs/", import.meta.url);
const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled"]);
const SMOKE_TIMEOUT_MS = 15_000;

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${text}`);
  }
  return JSON.parse(text) as T;
}

async function waitForTerminal(jobId: string, baseUrl: string): Promise<JobDetail> {
  const deadline = Date.now() + SMOKE_TIMEOUT_MS;
  while (true) {
    const detail = await fetchJson<JobDetail>(`${baseUrl}/api/jobs/${encodeURIComponent(jobId)}`);
    if (TERMINAL_STATES.has(detail.state)) {
      return detail;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for smoke dashboard job ${jobId}; latest state was ${detail.state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function ensureSmokeRun(baseUrl: string): Promise<JobDetail> {
  const jobs = await fetchJson<{ jobs: JobSnapshot[] }>(`${baseUrl}/api/jobs`);
  const usable = jobs.jobs.find((job) => job.artifact_count > 0 && TERMINAL_STATES.has(job.state));
  if (usable) {
    return fetchJson<JobDetail>(`${baseUrl}/api/jobs/${encodeURIComponent(usable.job_id)}`);
  }

  const launch = await launchEvidenceJob({
    case_id: "mavlink-ftp-path-handling",
    test_card_id: "mavlink-ftp-path-handling",
    target_commit: "dashboard-smoke-demo",
  });
  return waitForTerminal(launch.job_id, baseUrl);
}

async function main(): Promise<void> {
  await mkdir(fileURLToPath(RUNS_ROOT), { recursive: true });
  const { server, url } = await startDashboardServer({ port: 0 });
  try {
    const health = await fetchJson<{
      ok: boolean;
      runs_available: boolean;
      read_only: boolean;
      runs_dir: string;
    }>(`${url}/api/health`);
    assert.equal(health.ok, true, "health.ok must be true");
    assert.equal(health.runs_available, true, "health.runs_available must be true");
    assert.equal(health.read_only, true, "health must report read_only");
    assert.ok(health.runs_dir.endsWith("runs"), "health.runs_dir must point at runs directory");

    // Confirm mutation endpoints are not available.
    const postResponse = await fetch(`${url}/api/jobs`, { method: "POST" });
    assert.equal(postResponse.status, 405, "POST /api/jobs must be blocked");

    const detail = await ensureSmokeRun(url);
    assert.ok(detail.job_id.startsWith("job-"), "detail must include a job id");
    assert.ok(detail.request, "detail must include the launch request");
    assert.ok(detail.status, "detail must include the latest status");
    assert.ok(detail.recent_events.length > 0, "detail must include at least one event");

    const refreshed = await fetchJson<{ jobs: JobSnapshot[] }>(`${url}/api/jobs`);
    assert.ok(
      refreshed.jobs.some((job) => job.job_id === detail.job_id),
      "job list must include the smoke job",
    );

    const artifact = detail.artifacts.find((item) => item.name === "evidence-summary.md") ?? detail.artifacts[0];
    assert.ok(artifact, "smoke job must produce at least one artifact");

    const artifactResponse = await fetch(
      `${url}/api/jobs/${encodeURIComponent(detail.job_id)}/artifacts/${encodeURIComponent(artifact.name)}`,
    );
    assert.equal(artifactResponse.status, 200, "artifact fetch must succeed");
    const artifactText = await artifactResponse.text();
    assert.ok(artifactText.length > 0, "artifact fetch must return content");

    // Path traversal protection.
    const traversal = await fetch(
      `${url}/api/jobs/${encodeURIComponent(detail.job_id)}/artifacts/${encodeURIComponent("../job.json")}`,
    );
    assert.equal(traversal.status, 400, "path traversal must be rejected");

    console.log(
      JSON.stringify(
        {
          ok: true,
          url,
          repo_root: REPO_ROOT,
          smoke_job: {
            job_id: detail.job_id,
            state: detail.state,
            runner_kind: detail.runner_kind,
            artifact_count: detail.artifact_count,
            verified_artifact: artifact.name,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

await main();

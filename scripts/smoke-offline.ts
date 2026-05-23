import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { JobInspectionDetails, JobLaunchDetails } from "../src/domain/jobs.js";
import { createContactDepartureSession } from "../src/session.js";
import {
  DOMAIN_TOOL_NAMES,
  runCancelJob,
  runInspectJob,
  runLaunchEvidenceJob,
  runListCases,
  runListTestCards,
  runLoadCase,
} from "../src/tools/evidence.js";

const expectedTools = [...DOMAIN_TOOL_NAMES].sort();
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const jobsModuleUrl = new URL("../src/domain/jobs.ts", import.meta.url).href;
const terminalStates = new Set(["succeeded", "failed", "cancelled"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForState(jobId: string, predicate: (state: string) => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let latest = await runInspectJob({ job_id: jobId });
  while (!predicate(latest.details.state)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${jobId}; latest state was ${latest.details.state}`);
    }
    await sleep(75);
    latest = await runInspectJob({ job_id: jobId });
  }
  return latest;
}

function smokeChildEnv(): NodeJS.ProcessEnv {
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

function assertRunnerProcess(details: Pick<JobLaunchDetails | JobInspectionDetails, "runner">) {
  const runner = details.runner;
  const processMetadata = runner?.process;
  assert.equal(runner?.type, "fake-smoke");
  assert.equal(typeof processMetadata?.pid, "number");
  assert.equal(processMetadata?.entrypoint, "src/runners/fake-evidence-runner.ts");
  assert.equal(processMetadata?.detached, true);
  assert.equal(processMetadata?.cancel_signal, "SIGTERM");
}

function inspectFromFreshProcess(jobId: string): JobInspectionDetails {
  const code = [
    `const { inspectJob } = await import(${JSON.stringify(jobsModuleUrl)});`,
    "const jobId = process.argv.at(-1);",
    'if (!jobId) throw new Error("missing job id");',
    "const details = await inspectJob({ job_id: jobId });",
    "process.stdout.write(JSON.stringify(details));",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code, jobId], {
    cwd: repoRoot,
    encoding: "utf8",
    env: smokeChildEnv(),
  });

  if (result.status !== 0) {
    throw new Error(`Fresh inspect process failed: ${result.stderr || result.stdout}`);
  }

  return JSON.parse(result.stdout) as JobInspectionDetails;
}

const cases = await runListCases();
assert.equal(cases.details.cases.length >= 3, true);
assert.equal(cases.details.cases.some((item) => item.id === "mavlink-battery-status-bounds"), true);

const loadedCase = await runLoadCase({ case_id: "mavlink-battery-status-bounds" });
assert.equal(loadedCase.details.case.target_family, "MAVLink telemetry parser");
assert.equal(loadedCase.details.case.doc_snippet.includes("BATTERY_STATUS"), true);

const testCards = await runListTestCards();
assert.equal(testCards.details.test_cards.length >= 3, true);
assert.equal(testCards.details.test_cards.some((item) => item.id === "mavlink-parser-bounds"), true);

const prePatchJob = await runLaunchEvidenceJob({
  case_id: "mavlink-battery-status-bounds",
  test_card_id: "mavlink-parser-bounds",
  target_commit: "pre-patch-demo",
});
const postPatchJob = await runLaunchEvidenceJob({
  case_id: "mavlink-battery-status-bounds",
  test_card_id: "mavlink-parser-bounds",
  target_commit: "post-patch-demo",
});

for (const launch of [prePatchJob, postPatchJob]) {
  assert.equal(launch.details.state, "queued");
  assert.equal(terminalStates.has(launch.details.state), false, "launch should return before completion");
  assertRunnerProcess(launch.details);
  assert.equal(existsSync(launch.details.run_dir), true, `${launch.details.run_dir} should exist`);
  assert.equal(existsSync(`${launch.details.run_dir}/job.json`), true);
  assert.equal(existsSync(`${launch.details.run_dir}/status.json`), true);
  assert.equal(existsSync(`${launch.details.run_dir}/events.jsonl`), true);
  assert.equal(existsSync(launch.details.artifact_dir), true, `${launch.details.artifact_dir} should exist`);
}

const runningJob = await waitForState(prePatchJob.details.job_id, (state) => state === "running", 1500);
assert.equal(runningJob.details.state, "running");
assert.equal(runningJob.details.progress > 0, true);
assert.equal(runningJob.details.recent_events.length > 0, true);
assertRunnerProcess(runningJob.details);

const freshInspection = inspectFromFreshProcess(prePatchJob.details.job_id);
assert.equal(freshInspection.job_id, prePatchJob.details.job_id);
assert.equal(terminalStates.has(freshInspection.state), false);
assertRunnerProcess(freshInspection);

const cancelJob = await runLaunchEvidenceJob({
  case_id: "mavlink-ftp-path-handling",
  test_card_id: "mavlink-ftp-path-handling",
  target_commit: "cancel-demo",
});
assert.equal(cancelJob.details.state, "queued");
assertRunnerProcess(cancelJob.details);
const cancelRunning = await waitForState(cancelJob.details.job_id, (state) => state === "running", 1500);
assert.equal(cancelRunning.details.state, "running");

const cancelled = await runCancelJob({ job_id: cancelJob.details.job_id });
assert.equal(cancelled.details.state, "cancelled");
assert.equal(cancelled.details.cancel_action, "cancelled");
assertRunnerProcess(cancelled.details);
await sleep(1200);
const cancelledAfterDelay = await runInspectJob({ job_id: cancelJob.details.job_id });
assert.equal(cancelledAfterDelay.details.state, "cancelled");
assert.equal(cancelledAfterDelay.details.result?.verdict, "cancelled");

const prePatchComplete = await waitForState(prePatchJob.details.job_id, (state) => state === "succeeded", 5000);
const postPatchComplete = await waitForState(postPatchJob.details.job_id, (state) => state === "succeeded", 5000);

assert.equal(prePatchComplete.details.result?.verdict, "attention_required");
assert.equal(postPatchComplete.details.result?.verdict, "mitigation_observed");
assert.equal(prePatchComplete.details.result?.artifact_paths.length, 3);
assert.equal(postPatchComplete.details.result?.artifact_paths.length, 3);
for (const artifactPath of postPatchComplete.details.result?.artifact_paths ?? []) {
  assert.equal(existsSync(artifactPath), true, `${artifactPath} should exist`);
}

const { session } = await createContactDepartureSession();
try {
  const activeTools: string[] = [...session.getActiveToolNames()].sort();
  const configuredTools: string[] = session.getAllTools().map((tool) => tool.name).sort();

  assert.deepEqual(activeTools, expectedTools);
  assert.deepEqual(configuredTools, expectedTools);
  for (const blockedTool of ["bash", "read", "write", "edit", "grep", "find", "ls"]) {
    assert.equal((activeTools as readonly string[]).includes(blockedTool), false, `${blockedTool} must not be active`);
    assert.equal((configuredTools as readonly string[]).includes(blockedTool), false, `${blockedTool} must not be configured`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        activeTools,
        configuredTools,
        cases: cases.details.cases.map((item) => item.id),
        testCards: testCards.details.test_cards.map((item) => item.id),
        completedJob: {
          job_id: postPatchComplete.details.job_id,
          verdict: postPatchComplete.details.result?.verdict,
          artifacts: postPatchComplete.details.result?.artifact_paths,
        },
        cancelledJob: {
          job_id: cancelled.details.job_id,
          state: cancelled.details.state,
        },
      },
      null,
      2,
    ),
  );
} finally {
  session.dispose();
}

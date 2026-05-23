import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { JobInspectionDetails, JobLaunchDetails, RunnerKind } from "../src/domain/jobs.js";
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
const STATIC_SOURCE_TIMEOUT_MS = 120_000;
const MAVLINK_PARSER_FUZZ_TIMEOUT_MS = 180_000;
const ALLOWED_STATIC_VERDICTS = new Set([
  "static_evidence_consistent_with_claim",
  "static_evidence_conflicts_with_claim",
  "static_evidence_inconclusive",
  "static_evidence_unavailable",
]);

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
    await sleep(150);
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

function assertRunnerProcess(
  details: Pick<JobLaunchDetails | JobInspectionDetails, "runner">,
  expected: { kind: RunnerKind; entrypoint: string },
) {
  const runner = details.runner;
  const processMetadata = runner?.process;
  assert.equal(runner?.type, expected.kind);
  assert.equal(typeof processMetadata?.pid, "number");
  assert.equal(processMetadata?.entrypoint, expected.entrypoint);
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

// ---- Catalog assertions ----------------------------------------------------

const cases = await runListCases();
assert.equal(cases.details.cases.length >= 4, true);
assert.equal(cases.details.cases.some((item) => item.id === "mavlink-battery-status-bounds"), true);
assert.equal(cases.details.cases.some((item) => item.id === "mavlink-parser-library-fuzz"), true);

const loadedCase = await runLoadCase({ case_id: "mavlink-battery-status-bounds" });
assert.equal(loadedCase.details.case.doc_snippet.includes("BATTERY_STATUS"), true);

const testCards = await runListTestCards();
assert.equal(testCards.details.test_cards.length >= 4, true);
assert.equal(testCards.details.test_cards.some((item) => item.id === "mavlink-parser-bounds"), true);
assert.equal(testCards.details.test_cards.some((item) => item.id === "mavlink-parser-fuzz"), true);

// ---- Fake runner: FTP case end-to-end --------------------------------------

const fakeFtpJob = await runLaunchEvidenceJob({
  case_id: "mavlink-ftp-path-handling",
  test_card_id: "mavlink-ftp-path-handling",
  target_commit: "post-patch-demo",
});
assert.equal(fakeFtpJob.details.state, "queued");
assertRunnerProcess(fakeFtpJob.details, {
  kind: "fake-smoke",
  entrypoint: "src/runners/fake-evidence-runner.ts",
});
assert.equal(existsSync(fakeFtpJob.details.run_dir), true);
assert.equal(existsSync(`${fakeFtpJob.details.run_dir}/job.json`), true);
assert.equal(existsSync(fakeFtpJob.details.artifact_dir), true);

const fakeFtpRunning = await waitForState(fakeFtpJob.details.job_id, (state) => state === "running", 1500);
assertRunnerProcess(fakeFtpRunning.details, {
  kind: "fake-smoke",
  entrypoint: "src/runners/fake-evidence-runner.ts",
});

const freshInspection = inspectFromFreshProcess(fakeFtpJob.details.job_id);
assert.equal(freshInspection.job_id, fakeFtpJob.details.job_id);
assertRunnerProcess(freshInspection, {
  kind: "fake-smoke",
  entrypoint: "src/runners/fake-evidence-runner.ts",
});

const fakeFtpComplete = await waitForState(fakeFtpJob.details.job_id, (state) => state === "succeeded", 5000);
assert.equal(fakeFtpComplete.details.result?.runner_kind, "fake-smoke");
assert.equal(["no_issue_detected", "attention_required"].includes(fakeFtpComplete.details.result?.verdict ?? ""), true);
assert.equal(fakeFtpComplete.details.result?.artifact_paths.length, 3);
for (const artifactPath of fakeFtpComplete.details.result?.artifact_paths ?? []) {
  assert.equal(existsSync(artifactPath), true, `${artifactPath} should exist`);
}

// ---- Fake runner: cancellation ---------------------------------------------

const cancelJob = await runLaunchEvidenceJob({
  case_id: "mavlink-ftp-path-handling",
  test_card_id: "mavlink-ftp-path-handling",
  target_commit: "cancel-demo",
});
assert.equal(cancelJob.details.state, "queued");
assertRunnerProcess(cancelJob.details, {
  kind: "fake-smoke",
  entrypoint: "src/runners/fake-evidence-runner.ts",
});
const cancelRunning = await waitForState(cancelJob.details.job_id, (state) => state === "running", 1500);
assert.equal(cancelRunning.details.state, "running");

const cancelled = await runCancelJob({ job_id: cancelJob.details.job_id });
assert.equal(cancelled.details.state, "cancelled");
assert.equal(cancelled.details.cancel_action, "cancelled");
assertRunnerProcess(cancelled.details, {
  kind: "fake-smoke",
  entrypoint: "src/runners/fake-evidence-runner.ts",
});
await sleep(1200);
const cancelledAfterDelay = await runInspectJob({ job_id: cancelJob.details.job_id });
assert.equal(cancelledAfterDelay.details.state, "cancelled");
assert.equal(cancelledAfterDelay.details.result?.verdict, "cancelled");

// ---- Static-source runner: cancellation ------------------------------------

// Force a cold cache so the runner has to fetch, giving the cancellation a window
// to land before the work completes.
rmSync(join(repoRoot, ".cache", "px4"), { recursive: true, force: true });
rmSync(join(repoRoot, ".cache", "px4.lock"), { recursive: true, force: true });

const staticCancelLaunch = await runLaunchEvidenceJob({
  case_id: "mavlink-battery-status-bounds",
  test_card_id: "mavlink-parser-bounds",
  target_commit: "mavlink-battery-status-bounds-pre",
});
assertRunnerProcess(staticCancelLaunch.details, {
  kind: "static-source-evidence",
  entrypoint: "src/runners/static-source-evidence-runner.ts",
});

const staticCancelled = await runCancelJob({ job_id: staticCancelLaunch.details.job_id });
assert.equal(staticCancelled.details.state, "cancelled");
assert.equal(staticCancelled.details.cancel_action, "cancelled");
assertRunnerProcess(staticCancelled.details, {
  kind: "static-source-evidence",
  entrypoint: "src/runners/static-source-evidence-runner.ts",
});
await sleep(1500);
const staticCancelledAfter = await runInspectJob({ job_id: staticCancelLaunch.details.job_id });
assert.equal(staticCancelledAfter.details.state, "cancelled");
assert.equal(staticCancelledAfter.details.result?.verdict, "cancelled");

// ---- Static-source runner: parser-bounds pre/post --------------------------

const preLaunch = await runLaunchEvidenceJob({
  case_id: "mavlink-battery-status-bounds",
  test_card_id: "mavlink-parser-bounds",
  target_commit: "mavlink-battery-status-bounds-pre",
});
const postLaunch = await runLaunchEvidenceJob({
  case_id: "mavlink-battery-status-bounds",
  test_card_id: "mavlink-parser-bounds",
  target_commit: "mavlink-battery-status-bounds-post",
});

for (const launch of [preLaunch, postLaunch]) {
  assert.equal(launch.details.state, "queued");
  assert.equal(terminalStates.has(launch.details.state), false);
  assertRunnerProcess(launch.details, {
    kind: "static-source-evidence",
    entrypoint: "src/runners/static-source-evidence-runner.ts",
  });
  assert.equal(existsSync(launch.details.run_dir), true);
  assert.equal(existsSync(`${launch.details.run_dir}/job.json`), true);
  assert.equal(existsSync(launch.details.artifact_dir), true);
}

const preComplete = await waitForState(
  preLaunch.details.job_id,
  (state) => terminalStates.has(state),
  STATIC_SOURCE_TIMEOUT_MS,
);
const postComplete = await waitForState(
  postLaunch.details.job_id,
  (state) => terminalStates.has(state),
  STATIC_SOURCE_TIMEOUT_MS,
);

for (const completed of [preComplete, postComplete]) {
  const result = completed.details.result;
  assert.ok(result, "static-source job should have a result");
  assert.equal(result.runner_kind, "static-source-evidence");
  assert.equal(result.static_source?.case_id, "mavlink-battery-status-bounds");
  assert.equal(result.static_source?.test_card_id, "mavlink-parser-bounds");
  assert.ok(result.static_source?.resolved_commit_hash, "static_source.resolved_commit_hash should be set");
  assert.equal(
    ALLOWED_STATIC_VERDICTS.has(result.static_source?.verdict_kind ?? ""),
    true,
    `verdict_kind ${result.static_source?.verdict_kind} should be one of the four allowed values`,
  );
  assert.ok(result.summary && result.summary.length > 0);
  assert.ok(result.artifact_paths.length >= 1);
  for (const artifactPath of result.artifact_paths) {
    assert.equal(existsSync(artifactPath), true, `${artifactPath} should exist`);
  }
}

const preStatic = preComplete.details.result?.static_source;
const postStatic = postComplete.details.result?.static_source;
assert.ok(preStatic);
assert.ok(postStatic);
assert.notEqual(
  preStatic.resolved_commit_hash,
  postStatic.resolved_commit_hash,
  "pre and post aliases must resolve to different commit hashes",
);
assert.equal(preStatic.resolved_commit_hash, "12670b70f48fbbd9305ad6074d7f95d9853fc63d");
assert.equal(postStatic.resolved_commit_hash, "7ec7d9d173b3c4aedccdda51cbe670f70686b4b6");

const preState = preComplete.details.state;
const postState = postComplete.details.state;
const networkAvailable = preState === "succeeded" && postState === "succeeded";
let networkNote = "";

if (networkAvailable) {
  assert.equal(preStatic.verdict_kind, "static_evidence_conflicts_with_claim");
  assert.equal(postStatic.verdict_kind, "static_evidence_consistent_with_claim");
  assert.notEqual(preComplete.details.result?.verdict, postComplete.details.result?.verdict);

  for (const completed of [preComplete, postComplete]) {
    const result = completed.details.result;
    const sourceContextPath = result?.artifact_paths.find((p) => p.endsWith("source-context.md"));
    const commitInfoPath = result?.artifact_paths.find((p) => p.endsWith("commit-info.json"));
    const diffPatchPath = result?.artifact_paths.find((p) => p.endsWith("diff.patch"));
    const diffSummaryPath = result?.artifact_paths.find((p) => p.endsWith("diff-summary.md"));
    assert.ok(sourceContextPath, "source-context.md must be present in a successful static-source run");
    assert.ok(commitInfoPath, "commit-info.json must be present in a successful static-source run");
    assert.ok(diffPatchPath, "diff.patch must be present when a pre/post pair is implied");
    assert.ok(diffSummaryPath, "diff-summary.md must be present when a pre/post pair is implied");

    const commitInfo = JSON.parse(readFileSync(commitInfoPath, "utf8"));
    assert.equal(commitInfo.resolved_commit_hash, result?.static_source?.resolved_commit_hash);
    assert.equal(commitInfo.target_file, "src/modules/mavlink/mavlink_receiver.cpp");

    const diffPatch = readFileSync(diffPatchPath, "utf8");
    assert.equal(
      diffPatch.includes("src/modules/mavlink/mavlink_receiver.cpp"),
      true,
      "diff.patch should reference the target file",
    );
    assert.equal(
      diffPatch.includes("handle_message_battery_status"),
      true,
      "diff.patch should reference the target function",
    );

    const sourceContext = readFileSync(sourceContextPath, "utf8");
    assert.equal(
      sourceContext.includes("handle_message_battery_status"),
      true,
      "source-context.md should mention the target function",
    );
  }
} else {
  networkNote = `Static-source runner finished without succeeded state on at least one alias (pre=${preState}, post=${postState}); this is the documented network-restricted fallback path.`;
  for (const completed of [preComplete, postComplete]) {
    if (completed.details.state !== "succeeded") {
      assert.equal(completed.details.state, "failed");
      assert.equal(completed.details.result?.static_source?.verdict_kind, "static_evidence_unavailable");
      const failurePath = completed.details.result?.artifact_paths.find((p) => p.endsWith("failure.md"));
      assert.ok(failurePath, "failure.md must be present when the static-source runner cannot produce evidence");
      assert.equal(existsSync(failurePath), true);
    }
  }
}

// ---- MAVLink parser fuzz runner: end-to-end --------------------------------

const fuzzLaunch = await runLaunchEvidenceJob({
  case_id: "mavlink-parser-library-fuzz",
  test_card_id: "mavlink-parser-fuzz",
  target_commit: "parser-fuzz-smoke",
  budget_profile: "smoke-fast",
});
assert.equal(fuzzLaunch.details.state, "queued");
assertRunnerProcess(fuzzLaunch.details, {
  kind: "mavlink-parser-fuzz",
  entrypoint: "src/runners/mavlink-parser-fuzz-runner.ts",
});
assert.equal(existsSync(fuzzLaunch.details.run_dir), true);
assert.equal(existsSync(`${fuzzLaunch.details.run_dir}/job.json`), true);
assert.equal(existsSync(fuzzLaunch.details.artifact_dir), true);

const fuzzComplete = await waitForState(
  fuzzLaunch.details.job_id,
  (state) => terminalStates.has(state),
  MAVLINK_PARSER_FUZZ_TIMEOUT_MS,
);
const fuzzResult = fuzzComplete.details.result;
assert.ok(fuzzResult, "mavlink parser fuzz job should have a result");
assert.equal(fuzzResult.runner_kind, "mavlink-parser-fuzz");
assert.equal(["succeeded", "failed"].includes(fuzzComplete.details.state), true);

if (fuzzComplete.details.state === "succeeded") {
  assert.equal(["no_issue_detected", "attention_required"].includes(fuzzResult.verdict ?? ""), true);
  assert.ok(fuzzResult.mavlink_parser_fuzz, "mavlink_parser_fuzz metadata should be present");
  assert.ok(fuzzResult.mavlink_parser_fuzz?.pymavlink_version, "pymavlink version should be recorded");
  assert.equal(fuzzResult.mavlink_parser_fuzz?.mutation_budget, 100);
  assert.ok(fuzzResult.mavlink_parser_fuzz?.inputs_tried && fuzzResult.mavlink_parser_fuzz.inputs_tried > 0);

  const requiredArtifacts = [
    "evidence-summary.md",
    "parser-run-manifest.json",
    "parser-outcomes.csv",
    "seed-corpus.json",
    "runner.log",
  ];
  for (const name of requiredArtifacts) {
    const artifactPath: string | undefined = fuzzResult.artifact_paths.find((p) => p.endsWith(name));
    assert.ok(artifactPath, `${name} must be present in artifact_paths`);
    assert.equal(existsSync(artifactPath), true, `${artifactPath} should exist`);
  }

  const cautionText = (fuzzResult.cautions ?? []).join(" ").toLowerCase();
  assert.equal(cautionText.includes("parser-library"), true);
  assert.equal(cautionText.includes("not px4 sitl") || cautionText.includes("not px4 sitl evidence"), true);

  const manifest = JSON.parse(
    readFileSync(fuzzResult.artifact_paths.find((p) => p.endsWith("parser-run-manifest.json"))!, "utf8"),
  );
  assert.ok(manifest.pymavlink_version);
  assert.equal(manifest.mutation_budget, 100);
} else {
  const failurePath = fuzzResult.artifact_paths.find((p) => p.endsWith("failure.md"));
  assert.ok(failurePath, "failure.md must be present when parser fuzz setup fails");
  assert.equal(existsSync(failurePath!), true);
}

// ---- Tool surface ----------------------------------------------------------

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
        fakeFtpJob: {
          job_id: fakeFtpComplete.details.job_id,
          verdict: fakeFtpComplete.details.result?.verdict,
          runner_kind: fakeFtpComplete.details.result?.runner_kind,
          artifacts: fakeFtpComplete.details.result?.artifact_paths,
        },
        cancelledJob: {
          job_id: cancelled.details.job_id,
          state: cancelled.details.state,
        },
        staticSourceCancelledJob: {
          job_id: staticCancelLaunch.details.job_id,
          state: staticCancelledAfter.details.state,
        },
        staticSource: {
          network_available: networkAvailable,
          network_note: networkNote || undefined,
          pre: {
            job_id: preComplete.details.job_id,
            state: preComplete.details.state,
            verdict: preComplete.details.result?.verdict,
            verdict_kind: preStatic.verdict_kind,
            resolved_commit_hash: preStatic.resolved_commit_hash,
            artifacts: preComplete.details.result?.artifact_paths,
          },
          post: {
            job_id: postComplete.details.job_id,
            state: postComplete.details.state,
            verdict: postComplete.details.result?.verdict,
            verdict_kind: postStatic.verdict_kind,
            resolved_commit_hash: postStatic.resolved_commit_hash,
            artifacts: postComplete.details.result?.artifact_paths,
          },
        },
        mavlinkParserFuzz: {
          job_id: fuzzComplete.details.job_id,
          state: fuzzComplete.details.state,
          verdict: fuzzResult?.verdict,
          runner_kind: fuzzResult?.runner_kind,
          pymavlink_version: fuzzResult?.mavlink_parser_fuzz?.pymavlink_version,
          mutation_budget: fuzzResult?.mavlink_parser_fuzz?.mutation_budget,
          artifacts: fuzzResult?.artifact_paths,
        },
      },
      null,
      2,
    ),
  );
} finally {
  session.dispose();
}

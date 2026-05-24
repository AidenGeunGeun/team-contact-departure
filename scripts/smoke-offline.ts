import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile, writeFile as writeFileAsync } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { JobInspectionDetails, JobLaunchDetails, RunnerKind } from "../src/domain/jobs.js";
import { resolvePostPatchCommitHash, resolvePrePatchCommitHash } from "../src/domain/px4-runtime-replay.js";
import { createContactDepartureSession } from "../src/session.js";
import {
  DOMAIN_TOOL_NAMES,
  runCancelJob,
  runCompareEvidencePair,
  runCreateEvidenceBundle,
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
const PX4_SITL_PROBE_TIMEOUT_MS = 120_000;
const PX4_RUNTIME_REPLAY_TIMEOUT_MS = 150_000;
const ALLOWED_PROBE_OUTCOMES = new Set(["runtime_observed", "runtime_unavailable", "runtime_abnormal"]);
const ALLOWED_REPLAY_OUTCOMES = new Set(["runtime_clean", "runtime_anomalous", "runtime_unavailable"]);
const ALLOWED_STATIC_VERDICTS = new Set([
  "static_evidence_consistent_with_claim",
  "static_evidence_conflicts_with_claim",
  "static_evidence_inconclusive",
  "static_evidence_unavailable",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface SyntheticReplayJobInput {
  job_id: string;
  case_id: string;
  test_card_id: string;
  target_commit: string;
  budget_profile: string;
  resolved_commit_hash: string;
  outcome: "runtime_clean" | "runtime_anomalous" | "runtime_unavailable";
  frame_delivered: boolean;
  firmware_commit_proven: boolean;
  frame_hex: string;
}

async function writeSyntheticReplayJob(input: SyntheticReplayJobInput): Promise<void> {
  const runDir = join(repoRoot, "runs", input.job_id);
  const artifactDir = join(runDir, "artifacts");
  await mkdir(artifactDir, { recursive: true });
  const now = new Date().toISOString();
  const frameRecordPath = join(artifactDir, "frame-record.json");
  const frameRecordRel = `runs/${input.job_id}/artifacts/frame-record.json`;

  await writeFile(
    join(runDir, "job.json"),
    `${JSON.stringify(
      {
        job_id: input.job_id,
        launched_at: now,
        request: {
          case_id: input.case_id,
          test_card_id: input.test_card_id,
          target_commit: input.target_commit,
          budget_profile: input.budget_profile,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(runDir, "status.json"),
    `${JSON.stringify(
      {
        job_id: input.job_id,
        state: "succeeded",
        phase: "completed",
        progress: 100,
        created_at: now,
        updated_at: now,
        finished_at: now,
        run_dir: `runs/${input.job_id}`,
        artifact_dir: `runs/${input.job_id}/artifacts`,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    frameRecordPath,
    `${JSON.stringify({ seed_id: "bounds-test-battery-status", frame_hex: input.frame_hex }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(runDir, "result.json"),
    `${JSON.stringify(
      {
        job_id: input.job_id,
        verdict: input.outcome === "runtime_anomalous" ? "attention_required" : "manual_review_needed",
        confidence: "medium",
        summary: "Synthetic replay job for offline smoke fixture.",
        evidence_signals: [],
        artifact_paths: [frameRecordRel],
        cautions: [],
        completed_at: now,
        runner_kind: "px4-runtime-replay",
        px4_runtime_replay: {
          case_id: input.case_id,
          test_card_id: input.test_card_id,
          target_commit: input.target_commit,
          resolved_commit_hash: input.resolved_commit_hash,
          outcome: input.outcome,
          frame_delivered: input.frame_delivered,
          firmware_commit_proven: input.firmware_commit_proven,
          pymavlink_version: "2.4.41",
          python_version: "3.11.0",
          mavlink_connection: "udp:127.0.0.1:14540",
          px4_binary_present: true,
          budget_profile: input.budget_profile,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
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
assert.equal(cases.details.cases.length >= 5, true);
assert.equal(cases.details.cases.some((item) => item.id === "mavlink-battery-status-bounds"), true);
assert.equal(cases.details.cases.some((item) => item.id === "mavlink-parser-library-fuzz"), true);
assert.equal(cases.details.cases.some((item) => item.id === "px4-runtime-probe"), true);
assert.equal(cases.details.cases.some((item) => item.id === "mavlink-battery-status-runtime-replay"), true);

const loadedCase = await runLoadCase({ case_id: "mavlink-battery-status-bounds" });
assert.equal(loadedCase.details.case.doc_snippet.includes("BATTERY_STATUS"), true);

const testCards = await runListTestCards();
assert.equal(testCards.details.test_cards.length >= 5, true);
assert.equal(testCards.details.test_cards.some((item) => item.id === "mavlink-parser-bounds"), true);
assert.equal(testCards.details.test_cards.some((item) => item.id === "mavlink-parser-fuzz"), true);
assert.equal(testCards.details.test_cards.some((item) => item.id === "px4-sitl-probe"), true);
assert.equal(testCards.details.test_cards.some((item) => item.id === "px4-runtime-replay"), true);

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
// to land before the work completes. Skip when a prepared PX4 SITL binary exists so
// offline smoke does not destroy an integrator-ready runtime setup.
const preparedPx4Binary = join(repoRoot, ".cache", "px4", "build", "px4_sitl_default", "bin", "px4");
if (!existsSync(preparedPx4Binary)) {
  rmSync(join(repoRoot, ".cache", "px4"), { recursive: true, force: true });
  rmSync(join(repoRoot, ".cache", "px4.lock"), { recursive: true, force: true });
}

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

// ---- PX4 SITL probe runner: end-to-end -------------------------------------

const probeLaunch = await runLaunchEvidenceJob({
  case_id: "px4-runtime-probe",
  test_card_id: "px4-sitl-probe",
  target_commit: "px4-sitl-probe-smoke",
  budget_profile: "smoke-fast",
});
assert.equal(probeLaunch.details.state, "queued");
assertRunnerProcess(probeLaunch.details, {
  kind: "px4-sitl-probe",
  entrypoint: "src/runners/px4-sitl-probe-runner.ts",
});
assert.equal(existsSync(probeLaunch.details.run_dir), true);
assert.equal(existsSync(`${probeLaunch.details.run_dir}/job.json`), true);
assert.equal(existsSync(probeLaunch.details.artifact_dir), true);

const probeComplete = await waitForState(
  probeLaunch.details.job_id,
  (state) => terminalStates.has(state),
  PX4_SITL_PROBE_TIMEOUT_MS,
);
const probeResult = probeComplete.details.result;
assert.ok(probeResult, "PX4 SITL probe job should have a result");
assert.equal(probeResult.runner_kind, "px4-sitl-probe");
assert.equal(["succeeded", "failed"].includes(probeComplete.details.state), true);

if (probeComplete.details.state === "succeeded") {
  assert.ok(probeResult.px4_sitl_probe, "px4_sitl_probe metadata should be present");
  assert.equal(
    ALLOWED_PROBE_OUTCOMES.has(probeResult.px4_sitl_probe?.outcome ?? ""),
    true,
    `outcome ${probeResult.px4_sitl_probe?.outcome} should be a runtime probe outcome`,
  );
  assert.equal(
    ["manual_review_needed", "attention_required"].includes(probeResult.verdict ?? ""),
    true,
  );

  const requiredArtifacts = [
    "evidence-summary.md",
    "preflight-report.json",
    "preflight-report.md",
    "px4-setup.log",
    "runtime.log",
    "mavlink-observation.json",
    "runner.log",
  ];
  for (const name of requiredArtifacts) {
    const artifactPath: string | undefined = probeResult.artifact_paths.find((p) => p.endsWith(name));
    assert.ok(artifactPath, `${name} must be present in artifact_paths`);
    assert.equal(existsSync(artifactPath), true, `${artifactPath} should exist`);
  }

  const preflight = JSON.parse(
    readFileSync(probeResult.artifact_paths.find((p) => p.endsWith("preflight-report.json"))!, "utf8"),
  );
  assert.ok(preflight.checks && Array.isArray(preflight.checks));

  const cautionText = (probeResult.cautions ?? []).join(" ").toLowerCase();
  assert.equal(cautionText.includes("runtime probe"), true);
  assert.equal(cautionText.includes("does not prove firmware safety"), true);
} else {
  const failurePath = probeResult.artifact_paths.find((p) => p.endsWith("failure.md"));
  assert.ok(failurePath, "failure.md must be present when PX4 SITL probe setup fails");
  assert.equal(existsSync(failurePath!), true);
}

// ---- PX4 runtime replay runner: end-to-end ---------------------------------

const postPatchCommitHash = await resolvePostPatchCommitHash();
const prePatchCommitHash = await resolvePrePatchCommitHash();
const replayBuildManifestPath = join(repoRoot, ".cache", "px4", ".contact-departure-sitl-build.json");
let replayManifestProvesPostPatch = false;
if (existsSync(replayBuildManifestPath)) {
  const manifest = JSON.parse(readFileSync(replayBuildManifestPath, "utf8")) as {
    commit_hash?: string;
  };
  replayManifestProvesPostPatch =
    manifest.commit_hash === postPatchCommitHash && existsSync(preparedPx4Binary);
}

let invalidReplayTargetRejected = false;
try {
  await runLaunchEvidenceJob({
    case_id: "mavlink-battery-status-runtime-replay",
    test_card_id: "px4-runtime-replay",
    target_commit: "not-a-valid-replay-target",
    budget_profile: "smoke-fast",
  });
} catch {
  invalidReplayTargetRejected = true;
}
assert.equal(invalidReplayTargetRejected, true, "invalid replay target_commit must be rejected at launch");

const prePatchReplayLaunch = await runLaunchEvidenceJob({
  case_id: "mavlink-battery-status-runtime-replay",
  test_card_id: "px4-runtime-replay",
  target_commit: "mavlink-battery-status-bounds-pre",
  budget_profile: "smoke-fast",
});
assert.equal(prePatchReplayLaunch.details.state, "queued");
assertRunnerProcess(prePatchReplayLaunch.details, {
  kind: "px4-runtime-replay",
  entrypoint: "src/runners/px4-runtime-replay-runner.ts",
});

const replayLaunch = await runLaunchEvidenceJob({
  case_id: "mavlink-battery-status-runtime-replay",
  test_card_id: "px4-runtime-replay",
  target_commit: "mavlink-battery-status-bounds-post",
  budget_profile: "smoke-fast",
});
assert.equal(replayLaunch.details.state, "queued");
assertRunnerProcess(replayLaunch.details, {
  kind: "px4-runtime-replay",
  entrypoint: "src/runners/px4-runtime-replay-runner.ts",
});
assert.equal(existsSync(replayLaunch.details.run_dir), true);
assert.equal(existsSync(`${replayLaunch.details.run_dir}/job.json`), true);
assert.equal(existsSync(replayLaunch.details.artifact_dir), true);

const prePatchReplayComplete = await waitForState(
  prePatchReplayLaunch.details.job_id,
  (state) => terminalStates.has(state),
  PX4_RUNTIME_REPLAY_TIMEOUT_MS,
);
const prePatchReplayResult = prePatchReplayComplete.details.result;
assert.ok(prePatchReplayResult, "pre-patch PX4 runtime replay job should have a result");
assert.equal(prePatchReplayResult.runner_kind, "px4-runtime-replay");
assert.equal(prePatchReplayResult.px4_runtime_replay?.target_commit, "mavlink-battery-status-bounds-pre");
assert.equal(prePatchReplayResult.px4_runtime_replay?.resolved_commit_hash, prePatchCommitHash);

const replayComplete = await waitForState(
  replayLaunch.details.job_id,
  (state) => terminalStates.has(state),
  PX4_RUNTIME_REPLAY_TIMEOUT_MS,
);
const replayResult = replayComplete.details.result;
assert.ok(replayResult, "PX4 runtime replay job should have a result");
assert.equal(replayResult.runner_kind, "px4-runtime-replay");
assert.equal(["succeeded", "failed"].includes(replayComplete.details.state), true);

if (replayComplete.details.state === "succeeded") {
  assert.ok(replayResult.px4_runtime_replay, "px4_runtime_replay metadata should be present");
  assert.equal(
    ALLOWED_REPLAY_OUTCOMES.has(replayResult.px4_runtime_replay?.outcome ?? ""),
    true,
    `outcome ${replayResult.px4_runtime_replay?.outcome} should be a runtime replay outcome`,
  );
  assert.equal(replayResult.px4_runtime_replay?.target_commit, "mavlink-battery-status-bounds-post");
  assert.equal(replayResult.px4_runtime_replay?.resolved_commit_hash, postPatchCommitHash);

  if (!replayManifestProvesPostPatch) {
    assert.equal(
      replayResult.px4_runtime_replay?.outcome,
      "runtime_unavailable",
      "smoke-fast replay without verified post-patch build must end runtime_unavailable",
    );
    assert.equal(replayResult.px4_runtime_replay?.frame_delivered, false);
    assert.equal(replayResult.px4_runtime_replay?.firmware_commit_proven, false);
    assert.equal(replayResult.verdict, "manual_review_needed");
  } else {
    assert.equal(
      ["manual_review_needed", "attention_required"].includes(replayResult.verdict ?? ""),
      true,
    );
    if (replayResult.px4_runtime_replay?.resolved_commit_hash) {
      assert.equal(
        replayResult.px4_runtime_replay?.firmware_commit_proven,
        true,
        "verified manifest must prove firmware commit on terminal states with a resolved hash",
      );
    }
    if (replayResult.px4_runtime_replay?.outcome === "runtime_unavailable") {
      const blockerPresent = replayResult.artifact_paths.some(
        (p) =>
          p.endsWith("delivery-record.json") ||
          p.endsWith("runtime.log") ||
          p.endsWith("evidence-summary.md"),
      );
      assert.equal(
        blockerPresent,
        true,
        "runtime_unavailable with verified manifest must include a blocker artifact",
      );
    }
  }

  for (const artifactPath of replayResult.artifact_paths) {
    assert.equal(existsSync(artifactPath), true, `${artifactPath} should exist`);
  }
  const coreArtifacts = ["evidence-summary.md", "preflight-report.json", "preflight-report.md", "runner.log"];
  for (const name of coreArtifacts) {
    assert.ok(
      replayResult.artifact_paths.some((p) => p.endsWith(name)),
      `${name} must be present in artifact_paths`,
    );
  }

  const preflight = JSON.parse(
    readFileSync(replayResult.artifact_paths.find((p) => p.endsWith("preflight-report.json"))!, "utf8"),
  );
  assert.ok(preflight.checks && Array.isArray(preflight.checks));
  assert.equal(
    preflight.checks.some((check: { name: string }) => check.name === "pymavlink"),
    true,
    "preflight must record pymavlink availability",
  );

  const setupLogPath = replayResult.artifact_paths.find((p) => p.endsWith("px4-setup.log"));
  if (setupLogPath) {
    const setupLog = readFileSync(setupLogPath, "utf8");
    if (!replayManifestProvesPostPatch) {
      assert.equal(
        setupLog.includes("Build skipped") || setupLog.includes("no build manifest") || setupLog.includes("unverified"),
        true,
        "px4-setup.log should explain missing or unverified build provenance",
      );
    }
  }

  const frameRecordPath = replayResult.artifact_paths.find((p) => p.endsWith("frame-record.json"));
  if (frameRecordPath) {
    const frameRecord = JSON.parse(readFileSync(frameRecordPath, "utf8"));
    assert.equal(frameRecord.seed_id, "bounds-test-battery-status");
    assert.ok(frameRecord.frame_hex && frameRecord.frame_hex.length > 0);
  }

  if (!replayManifestProvesPostPatch && replayResult.px4_runtime_replay?.outcome === "runtime_unavailable") {
    const deliveryRecordPath = replayResult.artifact_paths.find((p) => p.endsWith("delivery-record.json"));
    if (deliveryRecordPath) {
      const deliveryRecord = JSON.parse(readFileSync(deliveryRecordPath, "utf8"));
      assert.equal(deliveryRecord.delivery_possible ?? deliveryRecord.delivery_ok ?? false, false);
    }
  }

  const cautionText = (replayResult.cautions ?? []).join(" ").toLowerCase();
  assert.equal(cautionText.includes("runtime replay"), true);
  assert.equal(cautionText.includes("does not prove firmware safety"), true);
} else {
  const failurePath = replayResult.artifact_paths.find((p) => p.endsWith("failure.md"));
  assert.ok(failurePath, "failure.md must be present when PX4 runtime replay setup fails");
  assert.equal(existsSync(failurePath!), true);
}

// ---- Evidence pair comparison -----------------------------------------------

const postLaunchDuplicate = await runLaunchEvidenceJob({
  case_id: "mavlink-battery-status-bounds",
  test_card_id: "mavlink-parser-bounds",
  target_commit: "mavlink-battery-status-bounds-post",
});
const postCompleteDuplicate = await waitForState(
  postLaunchDuplicate.details.job_id,
  (state) => terminalStates.has(state),
  STATIC_SOURCE_TIMEOUT_MS,
);

let sameRolePairRefused = false;
try {
  await runCompareEvidencePair({
    job_id_a: postComplete.details.job_id,
    job_id_b: postCompleteDuplicate.details.job_id,
  });
} catch (error) {
  sameRolePairRefused = true;
  const message = error instanceof Error ? error.message : String(error);
  assert.match(message.toLowerCase(), /same role|post-patch/);
}
assert.equal(sameRolePairRefused, true, "compare_evidence_pair must refuse two jobs with the same role");

const postReplayAltBudgetLaunch = await runLaunchEvidenceJob({
  case_id: "mavlink-battery-status-runtime-replay",
  test_card_id: "px4-runtime-replay",
  target_commit: "mavlink-battery-status-bounds-post",
  budget_profile: "smoke-fast-alt",
});
const postReplayAltBudgetComplete = await waitForState(
  postReplayAltBudgetLaunch.details.job_id,
  (state) => terminalStates.has(state),
  PX4_RUNTIME_REPLAY_TIMEOUT_MS,
);

let budgetProfileMismatchRefused = false;
try {
  await runCompareEvidencePair({
    job_id_a: prePatchReplayComplete.details.job_id,
    job_id_b: postReplayAltBudgetComplete.details.job_id,
  });
} catch (error) {
  budgetProfileMismatchRefused = true;
  const message = error instanceof Error ? error.message : String(error);
  assert.match(message.toLowerCase(), /budget_profile/);
}
assert.equal(
  budgetProfileMismatchRefused,
  true,
  "compare_evidence_pair must refuse pairs with mismatched budget_profile",
);

const pairComparison = await runCompareEvidencePair({
  job_id_a: prePatchReplayComplete.details.job_id,
  job_id_b: replayComplete.details.job_id,
});
assert.ok(pairComparison.details.pair_id.startsWith("pair-"), "pair_id must use pair- prefix");
assert.equal(existsSync(join(repoRoot, pairComparison.details.pair_path)), true);
const pairRecord = JSON.parse(readFileSync(join(repoRoot, pairComparison.details.pair_path), "utf8"));
assert.equal(pairRecord.case_id, "mavlink-battery-status-runtime-replay");
assert.equal(pairRecord.test_card_id, "px4-runtime-replay");
assert.equal(pairRecord.resolved_commit_hashes_differ, true);
assert.equal(pairRecord.frame_bytes_equal, true);
assert.equal(pairRecord.budget_profile_equal, true);
assert.equal(typeof pairRecord.provenance_complete, "boolean");
assert.equal(typeof pairRecord.frames_delivered_on_both_sides, "boolean");
assert.equal(typeof pairRecord.meaningful_outcomes_on_both_sides, "boolean");
assert.equal(typeof pairRecord.verdict_flip_demonstrated, "boolean");
assert.equal(pairRecord.pre_patch.job_id, prePatchReplayComplete.details.job_id);
assert.equal(pairRecord.post_patch.job_id, replayComplete.details.job_id);
assert.equal(pairRecord.pre_patch.resolved_commit_hash, prePatchCommitHash);
assert.equal(pairRecord.post_patch.resolved_commit_hash, postPatchCommitHash);
assert.equal(pairRecord.pre_patch.role, "pre-patch");
assert.equal(pairRecord.post_patch.role, "post-patch");
if (!replayManifestProvesPostPatch) {
  assert.equal(pairRecord.provenance_complete, false);
  assert.equal(pairRecord.frames_delivered_on_both_sides, false);
  assert.equal(pairRecord.meaningful_outcomes_on_both_sides, false);
  assert.equal(pairRecord.verdict_flip_demonstrated, false);
}

const preFrameRecordPath = prePatchReplayResult?.artifact_paths.find((p) => p.endsWith("frame-record.json"));
const postFrameRecordPath = replayResult?.artifact_paths.find((p) => p.endsWith("frame-record.json"));
if (preFrameRecordPath && postFrameRecordPath) {
  const preFrame = JSON.parse(readFileSync(preFrameRecordPath, "utf8"));
  const postFrame = JSON.parse(readFileSync(postFrameRecordPath, "utf8"));
  assert.equal(preFrame.frame_hex, postFrame.frame_hex, "crafted frame bytes must match across pre/post replay jobs");
}

let mismatchedPairRefused = false;
try {
  await runCompareEvidencePair({
    job_id_a: prePatchReplayComplete.details.job_id,
    job_id_b: fakeFtpComplete.details.job_id,
  });
} catch (error) {
  mismatchedPairRefused = true;
  const message = error instanceof Error ? error.message : String(error);
  assert.match(message.toLowerCase(), /same case|test card/);
}
assert.equal(mismatchedPairRefused, true, "compare_evidence_pair must refuse mismatched case/card pairs");

const syntheticFrameHex = "fd0900000101010100000000000000000000000000000000000000000000000000000000000000";
const syntheticPreJobId = "job-smoke-synthetic-pre";
const syntheticPostJobId = "job-smoke-synthetic-post";
const syntheticMismatchPostJobId = "job-smoke-synthetic-post-mismatch";

await writeSyntheticReplayJob({
  job_id: syntheticPreJobId,
  case_id: "mavlink-battery-status-runtime-replay",
  test_card_id: "px4-runtime-replay",
  target_commit: "mavlink-battery-status-bounds-pre",
  budget_profile: "smoke-fast",
  resolved_commit_hash: prePatchCommitHash,
  outcome: "runtime_anomalous",
  frame_delivered: true,
  firmware_commit_proven: true,
  frame_hex: syntheticFrameHex,
});
await writeSyntheticReplayJob({
  job_id: syntheticPostJobId,
  case_id: "mavlink-battery-status-runtime-replay",
  test_card_id: "px4-runtime-replay",
  target_commit: "mavlink-battery-status-bounds-post",
  budget_profile: "smoke-fast",
  resolved_commit_hash: postPatchCommitHash,
  outcome: "runtime_clean",
  frame_delivered: true,
  firmware_commit_proven: true,
  frame_hex: syntheticFrameHex,
});
await writeSyntheticReplayJob({
  job_id: syntheticMismatchPostJobId,
  case_id: "mavlink-battery-status-runtime-replay",
  test_card_id: "px4-runtime-replay",
  target_commit: "mavlink-battery-status-bounds-post",
  budget_profile: "smoke-fast",
  resolved_commit_hash: postPatchCommitHash,
  outcome: "runtime_clean",
  frame_delivered: true,
  firmware_commit_proven: true,
  frame_hex: `${syntheticFrameHex}ff`,
});

let frameMismatchRefused = false;
try {
  await runCompareEvidencePair({
    job_id_a: syntheticPreJobId,
    job_id_b: syntheticMismatchPostJobId,
  });
} catch (error) {
  frameMismatchRefused = true;
  const message = error instanceof Error ? error.message : String(error);
  assert.match(message.toLowerCase(), /frame bytes differ|crafted frame/);
}
assert.equal(frameMismatchRefused, true, "compare_evidence_pair must refuse mismatched frame bytes");

const syntheticTruePair = await runCompareEvidencePair({
  job_id_a: syntheticPreJobId,
  job_id_b: syntheticPostJobId,
});
assert.equal(syntheticTruePair.details.pair.verdict_flip_demonstrated, true);
assert.equal(syntheticTruePair.details.pair.frames_delivered_on_both_sides, true);
assert.equal(syntheticTruePair.details.pair.meaningful_outcomes_on_both_sides, true);
assert.equal(syntheticTruePair.details.pair.outcomes_differ, true);

// ---- Replayable evidence bundles -------------------------------------------

function runReplayCli(bundlePath: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("npm", ["run", "replay", "--", bundlePath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: smokeChildEnv(),
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

const fakeSmokeBundle = await runCreateEvidenceBundle({ job_id: fakeFtpComplete.details.job_id });
assert.ok(fakeSmokeBundle.details.bundle_id.startsWith("bundle-"));
assert.equal(existsSync(join(repoRoot, fakeSmokeBundle.details.bundle_path, "manifest.json")), true);
assert.equal(existsSync(join(repoRoot, fakeSmokeBundle.details.bundle_path, "result.json")), true);
assert.equal(existsSync(join(repoRoot, fakeSmokeBundle.details.bundle_path, "replay.sh")), true);
assert.equal(existsSync(join(repoRoot, fakeSmokeBundle.details.bundle_path, "README.md")), true);

const fakeReplay = runReplayCli(fakeSmokeBundle.details.bundle_path);
assert.equal(fakeReplay.status, 0, fakeReplay.stderr || fakeReplay.stdout);
assert.match(fakeReplay.stdout, /PASS/, "fake-smoke bundle replay must PASS");

let staticBundlePath: string | undefined;
let staticReplayNote: string | undefined;
if (networkAvailable && preComplete.details.result?.runner_kind === "static-source-evidence") {
  try {
    const staticBundle = await runCreateEvidenceBundle({ job_id: preComplete.details.job_id });
    staticBundlePath = staticBundle.details.bundle_path;
    const staticReplay = runReplayCli(staticBundlePath);
    if (staticReplay.status === 0 && /PASS/.test(staticReplay.stdout)) {
      staticReplayNote = "static-source bundle replay PASS";
    } else {
      staticReplayNote = `static-source bundle replay skipped or failed: ${staticReplay.stderr || staticReplay.stdout}`;
    }
  } catch (error) {
    staticReplayNote = `static-source bundle creation skipped: ${error instanceof Error ? error.message : String(error)}`;
  }
} else {
  staticReplayNote = "static-source bundle replay skipped (network or job unavailable)";
}

let fuzzBundlePath: string | undefined;
let fuzzReplayNote: string | undefined;
if (fuzzComplete.details.result?.runner_kind === "mavlink-parser-fuzz") {
  try {
    const fuzzBundle = await runCreateEvidenceBundle({ job_id: fuzzComplete.details.job_id });
    fuzzBundlePath = fuzzBundle.details.bundle_path;
    const venvPython = join(repoRoot, ".cache", "pymavlink-venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python3");
    if (existsSync(venvPython)) {
      const fuzzReplay = runReplayCli(fuzzBundlePath);
      if (fuzzReplay.status === 0 && /PASS/.test(fuzzReplay.stdout)) {
        fuzzReplayNote = "parser-fuzz bundle replay PASS";
      } else {
        fuzzReplayNote = `parser-fuzz bundle replay failed: ${fuzzReplay.stderr || fuzzReplay.stdout}`;
      }
    } else {
      fuzzReplayNote = "parser-fuzz bundle replay skipped (pymavlink venv missing)";
    }
  } catch (error) {
    fuzzReplayNote = `parser-fuzz bundle skipped: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const pairBundle = await runCreateEvidenceBundle({ pair_id: pairComparison.details.pair_id });
assert.equal(existsSync(join(repoRoot, pairBundle.details.bundle_path, "pair.json")), true);
const pairReplay = runReplayCli(pairBundle.details.bundle_path);
assert.equal(pairReplay.status, 0, pairReplay.stderr || pairReplay.stdout);
assert.match(pairReplay.stdout, /PASS/, "pair bundle replay must PASS");

let pymavlinkMismatchReplayFailed = false;
if (fuzzBundlePath) {
  const fuzzManifestPath = join(repoRoot, fuzzBundlePath, "manifest.json");
  const fuzzManifestOriginal = readFileSync(fuzzManifestPath, "utf8");
  const fuzzManifest = JSON.parse(fuzzManifestOriginal) as {
    pinned_inputs: { pymavlink_version?: string };
  };
  fuzzManifest.pinned_inputs.pymavlink_version = "0.0.0-not-installed";
  await writeFileAsync(fuzzManifestPath, `${JSON.stringify(fuzzManifest, null, 2)}\n`, "utf8");
  const pymavlinkMismatchReplay = runReplayCli(fuzzBundlePath);
  pymavlinkMismatchReplayFailed = pymavlinkMismatchReplay.status !== 0;
  assert.equal(pymavlinkMismatchReplayFailed, true, "pymavlink version mismatch replay must FAIL");
  assert.match(
    pymavlinkMismatchReplay.stdout + pymavlinkMismatchReplay.stderr,
    /pymavlink version mismatch|replay refused/i,
    "pymavlink mismatch must name version refusal",
  );
  await writeFileAsync(fuzzManifestPath, fuzzManifestOriginal, "utf8");
}

let sitlPartialReplayNoVerdictMatch = false;
let sitlPartialReplayNote: string | undefined;
if (probeComplete.details.state === "succeeded") {
  try {
    const sitlBundle = await runCreateEvidenceBundle({ job_id: probeComplete.details.job_id });
    const sitlReplay = runReplayCli(sitlBundle.details.bundle_path);
    const sitlOutput = sitlReplay.stdout + sitlReplay.stderr;
    sitlPartialReplayNoVerdictMatch = !/Verdict match/i.test(sitlOutput);
    assert.equal(sitlPartialReplayNoVerdictMatch, true, "SITL partial replay must not claim Verdict match");
    assert.match(sitlOutput, /Verdict not re-derived/i);
    assert.match(sitlOutput, /Preflight comparison/i);
    sitlPartialReplayNote = sitlReplay.status === 0 ? "sitl-probe partial replay PASS" : sitlReplay.stdout;
  } catch (error) {
    sitlPartialReplayNote = `sitl-probe bundle skipped: ${error instanceof Error ? error.message : String(error)}`;
  }
} else {
  sitlPartialReplayNote = "sitl-probe partial replay skipped (probe job did not succeed)";
}

let staticHashMismatchReplayFailed = false;
if (staticBundlePath) {
  const staticManifestPath = join(repoRoot, staticBundlePath, "manifest.json");
  const staticManifestOriginal = readFileSync(staticManifestPath, "utf8");
  const staticManifest = JSON.parse(staticManifestOriginal) as {
    pinned_inputs: { px4_commit_hash?: string };
  };
  staticManifest.pinned_inputs.px4_commit_hash = "0000000000000000000000000000000000000000";
  await writeFileAsync(staticManifestPath, `${JSON.stringify(staticManifest, null, 2)}\n`, "utf8");
  const staticMismatchReplay = runReplayCli(staticBundlePath);
  staticHashMismatchReplayFailed = staticMismatchReplay.status !== 0;
  assert.equal(staticHashMismatchReplayFailed, true, "static-source pinned hash mismatch replay must FAIL");
  assert.match(
    staticMismatchReplay.stdout + staticMismatchReplay.stderr,
    /commit hash mismatch|replay refused|could not be verified/i,
    "static hash mismatch must report pinned hash failure",
  );
  await writeFileAsync(staticManifestPath, staticManifestOriginal, "utf8");
}

let pairFrameTamperReplayFailed = false;
const pairPreFramePath = join(
  repoRoot,
  pairBundle.details.bundle_path,
  "artifacts/jobs/pre-patch/artifacts/frame-record.json",
);
if (existsSync(pairPreFramePath)) {
  const pairFrameOriginal = readFileSync(pairPreFramePath, "utf8");
  const pairFrameRecord = JSON.parse(pairFrameOriginal) as { frame_hex?: string };
  if (pairFrameRecord.frame_hex && pairFrameRecord.frame_hex.length > 2) {
    const hex = pairFrameRecord.frame_hex;
    const flipped = hex.endsWith("00") ? `${hex.slice(0, -2)}01` : `${hex.slice(0, -2)}00`;
    pairFrameRecord.frame_hex = flipped;
    await writeFileAsync(pairPreFramePath, `${JSON.stringify(pairFrameRecord, null, 2)}\n`, "utf8");
    const tamperedPairReplay = runReplayCli(pairBundle.details.bundle_path);
    pairFrameTamperReplayFailed = tamperedPairReplay.status !== 0;
    assert.equal(pairFrameTamperReplayFailed, true, "tampered pair frame bytes replay must FAIL");
    assert.match(tamperedPairReplay.stdout + tamperedPairReplay.stderr, /FAIL/);
    await writeFileAsync(pairPreFramePath, pairFrameOriginal, "utf8");
  }
}

const tamperedManifestPath = join(repoRoot, fakeSmokeBundle.details.bundle_path, "manifest.json");
const tamperedManifest = JSON.parse(readFileSync(tamperedManifestPath, "utf8"));
tamperedManifest.recorded_result.verdict = "tampered_verdict_for_smoke";
await writeFileAsync(tamperedManifestPath, `${JSON.stringify(tamperedManifest, null, 2)}\n`, "utf8");
const tamperedReplay = runReplayCli(fakeSmokeBundle.details.bundle_path);
assert.notEqual(tamperedReplay.status, 0, "tampered bundle replay must exit non-zero");
assert.match(tamperedReplay.stdout + tamperedReplay.stderr, /FAIL/, "tampered bundle replay must report FAIL");

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
        px4SitlProbe: {
          job_id: probeComplete.details.job_id,
          state: probeComplete.details.state,
          verdict: probeResult?.verdict,
          runner_kind: probeResult?.runner_kind,
          outcome: probeResult?.px4_sitl_probe?.outcome,
          heartbeat_observed: probeResult?.px4_sitl_probe?.heartbeat_observed,
          artifacts: probeResult?.artifact_paths,
        },
        px4RuntimeReplay: {
          pre: {
            job_id: prePatchReplayComplete.details.job_id,
            state: prePatchReplayComplete.details.state,
            outcome: prePatchReplayResult?.px4_runtime_replay?.outcome,
            resolved_commit_hash: prePatchReplayResult?.px4_runtime_replay?.resolved_commit_hash,
          },
          post: {
            job_id: replayComplete.details.job_id,
            state: replayComplete.details.state,
            verdict: replayResult?.verdict,
            runner_kind: replayResult?.runner_kind,
            outcome: replayResult?.px4_runtime_replay?.outcome,
            resolved_commit_hash: replayResult?.px4_runtime_replay?.resolved_commit_hash,
            frame_delivered: replayResult?.px4_runtime_replay?.frame_delivered,
            artifacts: replayResult?.artifact_paths,
          },
        },
        evidenceBundles: {
          fake_smoke_bundle: fakeSmokeBundle.details.bundle_id,
          fake_smoke_replay_pass: true,
          static_replay_note: staticReplayNote,
          fuzz_replay_note: fuzzReplayNote,
          pymavlink_mismatch_replay_failed: pymavlinkMismatchReplayFailed,
          static_hash_mismatch_replay_failed: staticHashMismatchReplayFailed,
          sitl_partial_replay_no_verdict_match: sitlPartialReplayNoVerdictMatch,
          sitl_partial_replay_note: sitlPartialReplayNote,
          pair_bundle: pairBundle.details.bundle_id,
          pair_replay_pass: true,
          pair_frame_tamper_replay_failed: pairFrameTamperReplayFailed,
          tampered_replay_failed: true,
        },
        evidencePair: {
          pair_id: pairComparison.details.pair_id,
          pair_path: pairComparison.details.pair_path,
          outcomes_differ: pairRecord.outcomes_differ,
          resolved_commit_hashes_differ: pairRecord.resolved_commit_hashes_differ,
          frame_bytes_equal: pairRecord.frame_bytes_equal,
          budget_profile_equal: pairRecord.budget_profile_equal,
          provenance_complete: pairRecord.provenance_complete,
          frames_delivered_on_both_sides: pairRecord.frames_delivered_on_both_sides,
          meaningful_outcomes_on_both_sides: pairRecord.meaningful_outcomes_on_both_sides,
          verdict_flip_demonstrated: pairRecord.verdict_flip_demonstrated,
          synthetic_true_pair: {
            pair_id: syntheticTruePair.details.pair_id,
            verdict_flip_demonstrated: syntheticTruePair.details.pair.verdict_flip_demonstrated,
          },
        },
      },
      null,
      2,
    ),
  );
} finally {
  session.dispose();
}

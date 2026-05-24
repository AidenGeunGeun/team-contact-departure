import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCase } from "../domain/catalog.js";
import { readEvidencePair } from "../domain/evidence-pair.js";
import {
  inspectJob,
  type JobState,
} from "../domain/jobs.js";
import {
  runCancelJob,
  runCompareEvidencePair,
  runCreateEvidenceBundle,
  runInspectJob,
  runLaunchEvidenceJob,
  runListCases,
  runLoadCase,
} from "../tools/evidence.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RUNS_ROOT = join(REPO_ROOT, "runs");
const PAIRS_ROOT = join(REPO_ROOT, "pairs");

const TERMINAL_STATES = new Set<JobState>(["succeeded", "failed", "cancelled"]);

const CASE_DEFAULT_TEST_CARDS: Record<string, string> = {
  "mavlink-battery-status-bounds": "mavlink-parser-bounds",
  "mavlink-battery-status-runtime-replay": "px4-runtime-replay",
  "px4-runtime-probe": "px4-sitl-probe",
  "mavlink-parser-library-fuzz": "mavlink-parser-fuzz",
  "mavlink-ftp-path-handling": "mavlink-ftp-path-handling",
  "unclear-telemetry-dropout-claim": "telemetry-conformance-review",
};

const MODE_TO_BUDGET: Record<string, string> = {
  smoke: "smoke-fast",
  local: "local-default",
  asan: "asan-default",
};

const PRE_POST_CASES = new Set(["mavlink-battery-status-bounds", "mavlink-battery-status-runtime-replay"]);

const DEMO_TARGETS: Record<string, string> = {
  "mavlink-battery-status-bounds": "mavlink-battery-status-bounds-post",
  "mavlink-battery-status-runtime-replay": "mavlink-battery-status-bounds-post",
  "px4-runtime-probe": "px4-sitl-probe-demo",
  "mavlink-parser-library-fuzz": "parser-fuzz-demo",
  "mavlink-ftp-path-handling": "post-patch-demo",
  "unclear-telemetry-dropout-claim": "vague-claim-demo",
};

function toolText(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content.find((item) => item.type === "text");
  return block?.text ?? "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveMode(mode: string): string {
  const normalized = mode.trim().toLowerCase();
  const budget = MODE_TO_BUDGET[normalized];
  if (!budget) {
    throw new Error(`Unknown mode "${mode}". Use smoke, local, or asan.`);
  }
  return budget;
}

function resolveTarget(caseId: string, target: string): string {
  const normalized = target.trim().toLowerCase();
  if (normalized === "pre") {
    if (PRE_POST_CASES.has(caseId)) {
      return "mavlink-battery-status-bounds-pre";
    }
    throw new Error(`Case "${caseId}" does not support --target pre. Use demo or a run label.`);
  }
  if (normalized === "post") {
    if (PRE_POST_CASES.has(caseId)) {
      return "mavlink-battery-status-bounds-post";
    }
    throw new Error(`Case "${caseId}" does not support --target post. Use demo or a run label.`);
  }
  if (normalized === "demo") {
    const demoTarget = DEMO_TARGETS[caseId];
    if (!demoTarget) {
      throw new Error(`Case "${caseId}" has no demo target mapping. Pass an explicit target label.`);
    }
    return demoTarget;
  }
  return target;
}

function resolveTestCard(caseId: string, override?: string): string {
  if (override) {
    return override;
  }
  const card = CASE_DEFAULT_TEST_CARDS[caseId];
  if (!card) {
    throw new Error(`No default methodology for case "${caseId}". Pass --card <test_card_id>.`);
  }
  return card;
}

function isSafeJobId(jobId: string): boolean {
  return /^job-[a-z0-9-]+$/i.test(jobId);
}

function isSafePairId(pairId: string): boolean {
  return /^pair-[a-z0-9-]+$/i.test(pairId);
}

function printHelp(): void {
  console.log(`Contact Departure project CLI

Usage:
  npm run contact -- help
  npm run contact -- cases
  npm run contact -- show <case>
  npm run contact -- run <case> --target <target> --mode <mode> [--card <card>]
  npm run contact -- jobs
  npm run contact -- job <job_id>
  npm run contact -- watch <job_id> [--timeout <seconds>]
  npm run contact -- cancel <job_id>
  npm run contact -- pair <job_id_a> <job_id_b>
  npm run contact -- bundle <job_or_pair_id>

Targets: pre, post, demo, or an explicit commit/run label.
Modes: smoke (smoke-fast), local (local-default), asan (asan-default).

Examples:
  npm run contact -- run mavlink-battery-status-bounds --target post --mode smoke
  npm run contact -- watch job-20260524-abc123
  npm run contact -- pair job-... job-...
  npm run contact -- bundle pair-20260524-abc123`);
}

async function cmdCases(): Promise<void> {
  console.log(toolText(await runListCases()));
}

async function cmdShow(caseId: string): Promise<void> {
  if (!caseId) {
    throw new Error("Missing case id. Usage: npm run contact -- show <case>");
  }
  console.log(toolText(await runLoadCase({ case_id: caseId })));
  const card = CASE_DEFAULT_TEST_CARDS[caseId] ?? "<card>";
  console.log("");
  console.log("Recommended commands:");
  if (PRE_POST_CASES.has(caseId)) {
    console.log(`  npm run contact -- run ${caseId} --target pre --mode smoke`);
    console.log(`  npm run contact -- run ${caseId} --target post --mode smoke`);
  } else {
    console.log(`  npm run contact -- run ${caseId} --target demo --mode smoke`);
  }
  console.log(`  npm run contact -- run ${caseId} --target demo --mode local --card ${card}`);
}

async function cmdRun(args: string[]): Promise<void> {
  const caseId = args[0];
  if (!caseId) {
    throw new Error("Missing case id. Usage: npm run contact -- run <case> --target <target> --mode <mode>");
  }

  let target: string | undefined;
  let mode: string | undefined;
  let card: string | undefined;
  for (let i = 1; i < args.length; i += 1) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === "--target" && value) {
      target = value;
      i += 1;
    } else if (flag === "--mode" && value) {
      mode = value;
      i += 1;
    } else if (flag === "--card" && value) {
      card = value;
      i += 1;
    }
  }

  if (!target) {
    throw new Error("Missing --target. Use pre, post, demo, or an explicit commit/run label.");
  }
  if (!mode) {
    throw new Error("Missing --mode. Use smoke, local, or asan.");
  }

  await loadCase(caseId);
  const resolvedTarget = resolveTarget(caseId, target);
  const budgetProfile = resolveMode(mode);
  const testCardId = resolveTestCard(caseId, card);

  const result = await runLaunchEvidenceJob({
    case_id: caseId,
    test_card_id: testCardId,
    target_commit: resolvedTarget,
    budget_profile: budgetProfile,
  });
  console.log(toolText(result));
  console.log("");
  console.log(`Next: npm run contact -- watch ${result.details.job_id}`);
}

async function cmdJobs(): Promise<void> {
  let entries;
  try {
    entries = await readdir(RUNS_ROOT, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      console.log("No evidence jobs yet.");
      return;
    }
    throw error;
  }

  const jobIds = entries.filter((entry) => entry.isDirectory() && isSafeJobId(entry.name)).map((entry) => entry.name);
  if (jobIds.length === 0) {
    console.log("No evidence jobs yet.");
    return;
  }

  const snapshots = await Promise.all(
    jobIds.map(async (jobId) => {
      const details = await inspectJob({ job_id: jobId });
      return {
        job_id: details.job_id,
        state: details.state,
        phase: details.phase,
        progress: details.progress,
        verdict: details.result?.verdict,
      };
    }),
  );

  console.log("Evidence jobs:");
  for (const job of snapshots.sort((a, b) => b.job_id.localeCompare(a.job_id))) {
    const verdict = job.verdict ? ` · ${job.verdict}` : "";
    console.log(`- ${job.job_id}: ${job.state}/${job.phase} ${job.progress}%${verdict}`);
  }
  console.log("");
  console.log("Inspect one: npm run contact -- job <job_id>");
}

async function cmdJob(jobId: string): Promise<void> {
  if (!jobId) {
    throw new Error("Missing job id. Usage: npm run contact -- job <job_id>");
  }
  console.log(toolText(await runInspectJob({ job_id: jobId })));
}

async function cmdWatch(jobId: string, timeoutSeconds = 300): Promise<void> {
  if (!jobId) {
    throw new Error("Missing job id. Usage: npm run contact -- watch <job_id>");
  }

  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastEventCount = 0;

  while (true) {
    const details = await inspectJob({ job_id: jobId });
    const events = details.recent_events;
    if (events.length > lastEventCount) {
      for (const event of events.slice(lastEventCount)) {
        console.log(`${event.timestamp}  ${event.state}/${event.phase} ${event.progress}%  ${event.message}`);
      }
      lastEventCount = events.length;
    } else {
      console.log(`${details.state}/${details.phase} ${details.progress}%  ${details.message}`);
    }

    if (TERMINAL_STATES.has(details.state)) {
      console.log("");
      console.log(toolText(await runInspectJob({ job_id: jobId })));
      if (details.artifact_dir) {
        console.log("");
        console.log(`Artifacts: ${details.artifact_dir}`);
      }
      return;
    }

    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutSeconds}s waiting for ${jobId} (state=${details.state}).`);
    }
    await sleep(1500);
  }
}

async function cmdCancel(jobId: string): Promise<void> {
  if (!jobId) {
    throw new Error("Missing job id. Usage: npm run contact -- cancel <job_id>");
  }
  console.log(toolText(await runCancelJob({ job_id: jobId })));
}

async function cmdPair(jobIdA: string, jobIdB: string): Promise<void> {
  if (!jobIdA || !jobIdB) {
    throw new Error("Usage: npm run contact -- pair <job_id_a> <job_id_b>");
  }
  console.log(toolText(await runCompareEvidencePair({ job_id_a: jobIdA, job_id_b: jobIdB })));
}

async function resolveBundleInput(id: string): Promise<{ job_id?: string; pair_id?: string }> {
  if (existsSync(join(PAIRS_ROOT, id, "pair.json"))) {
    return { pair_id: id };
  }
  if (existsSync(join(RUNS_ROOT, id, "status.json"))) {
    return { job_id: id };
  }
  if (isSafePairId(id)) {
    const pair = await readEvidencePair(id);
    if (pair) {
      return { pair_id: id };
    }
  }
  if (isSafeJobId(id)) {
    await inspectJob({ job_id: id });
    return { job_id: id };
  }
  throw new Error(`Unknown job or pair id "${id}".`);
}

async function cmdBundle(id: string): Promise<void> {
  if (!id) {
    throw new Error("Missing job or pair id. Usage: npm run contact -- bundle <job_or_pair_id>");
  }
  const input = await resolveBundleInput(id);
  console.log(toolText(await runCreateEvidenceBundle(input)));
}

export async function runContactCli(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  const command = args[0];

  try {
    switch (command) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        printHelp();
        return 0;
      case "cases":
        await cmdCases();
        return 0;
      case "show":
        await cmdShow(args[1] ?? "");
        return 0;
      case "run":
        await cmdRun(args.slice(1));
        return 0;
      case "jobs":
        await cmdJobs();
        return 0;
      case "job":
        await cmdJob(args[1] ?? "");
        return 0;
      case "watch": {
        let timeoutSeconds = 300;
        const jobId = args[1];
        for (let i = 2; i < args.length; i += 1) {
          if (args[i] === "--timeout" && args[i + 1]) {
            timeoutSeconds = Number.parseInt(args[i + 1]!, 10);
            if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
              throw new Error("--timeout must be a positive number of seconds.");
            }
            i += 1;
          }
        }
        await cmdWatch(jobId ?? "", timeoutSeconds);
        return 0;
      }
      case "cancel":
        await cmdCancel(args[1] ?? "");
        return 0;
      case "pair":
        await cmdPair(args[1] ?? "", args[2] ?? "");
        return 0;
      case "bundle":
        await cmdBundle(args[1] ?? "");
        return 0;
      default:
        console.error(`Unknown command "${command}".`);
        printHelp();
        return 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    return 1;
  }
}

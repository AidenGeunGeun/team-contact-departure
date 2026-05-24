import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvidenceResult } from "../domain/jobs.js";
import { buildFullReplayOutcome } from "./report.js";
import type { BundleManifest, ReplayOutcome } from "./types.js";

function stableHash(input: string): number {
  let hash = 0;
  for (const char of input) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash;
}

export function deriveFakeSmokeVerdict(caseId: string, targetCommit: string): string {
  if (targetCommit.includes("runner-fail-demo")) {
    return "runner_failed";
  }
  if (caseId === "unclear-telemetry-dropout-claim") {
    return "manual_review_needed";
  }
  const hash = stableHash(`${caseId}:${targetCommit}`);
  const traversalRejected = hash % 2 === 0 || targetCommit.includes("post-patch-demo");
  return traversalRejected ? "no_issue_detected" : "attention_required";
}

export async function replayFakeSmoke(bundleDir: string, manifest: BundleManifest): Promise<ReplayOutcome> {
  const resultPath = join(bundleDir, "result.json");
  const result = JSON.parse(await readFile(resultPath, "utf8")) as EvidenceResult;
  const rederived = deriveFakeSmokeVerdict(manifest.case_id, manifest.target_commit);
  const recorded = manifest.recorded_result.verdict;
  const pass = rederived === recorded;
  return buildFullReplayOutcome({
    lines: [
      "Trivial deterministic replay: re-derived verdict from case_id and target_commit.",
      "No LLM, agent session, or runtime environment required.",
    ],
    pass,
    rederived_verdict: rederived,
    recorded_verdict: recorded,
  });
}

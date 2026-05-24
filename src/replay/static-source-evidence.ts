import { produceStaticSourceEvidence } from "../domain/static-source-evidence.js";
import { buildFullReplayOutcome, buildRefusedReplayOutcome } from "./report.js";
import type { BundleManifest, ReplayOutcome } from "./types.js";

function mapStaticVerdictToEvidenceVerdict(verdictKind: string): string {
  if (verdictKind === "static_evidence_consistent_with_claim") {
    return "mitigation_observed";
  }
  if (verdictKind === "static_evidence_conflicts_with_claim") {
    return "attention_required";
  }
  return "manual_review_needed";
}

function commitVerifiedInCache(
  pinnedHash: string,
  outcome: Awaited<ReturnType<typeof produceStaticSourceEvidence>>,
): boolean {
  if (outcome.kind === "evidence") {
    const hash = outcome.evidence.commit.hash.toLowerCase();
    return hash === pinnedHash || hash.startsWith(pinnedHash) || pinnedHash.startsWith(hash);
  }
  if (outcome.failure.resolved_commit_hash?.toLowerCase() !== pinnedHash) {
    return false;
  }
  const stage = outcome.failure.stage ?? "";
  if (stage === "ensure-commit" || outcome.failure.summary.includes("Could not fetch PX4 commit")) {
    return false;
  }
  return true;
}

export async function replayStaticSourceEvidence(manifest: BundleManifest): Promise<ReplayOutcome> {
  const pinnedHash = String(manifest.pinned_inputs.px4_commit_hash ?? "").trim().toLowerCase();
  if (!pinnedHash) {
    return buildRefusedReplayOutcome({
      lines: ["Full replay refused: manifest.pinned_inputs.px4_commit_hash is missing."],
      recorded_verdict: manifest.recorded_result.verdict,
    });
  }

  const outcome = await produceStaticSourceEvidence({
    case_id: manifest.case_id,
    test_card_id: manifest.test_card_id,
    target_commit: pinnedHash,
  });

  if (!commitVerifiedInCache(pinnedHash, outcome)) {
    return buildRefusedReplayOutcome({
      lines: [
        "Full replay refused: pinned px4_commit_hash could not be verified in local cache after fetch.",
        `Pinned px4_commit_hash: ${pinnedHash}`,
        outcome.kind === "failure"
          ? `Fetch/read failure: ${outcome.failure.summary}`
          : "Commit metadata did not match pinned hash.",
      ],
      recorded_verdict: manifest.recorded_result.verdict,
    });
  }

  const rederived =
    outcome.kind === "evidence"
      ? mapStaticVerdictToEvidenceVerdict(outcome.evidence.verdict_kind)
      : "manual_review_needed";
  const recorded = manifest.recorded_result.verdict;
  const pass = rederived === recorded;

  const lines = [
    "Full replay: fetched PX4 at pinned commit and re-ran static source-pattern check.",
    `Pinned px4_commit_hash: ${pinnedHash} (verified after fetch)`,
    outcome.kind === "evidence"
      ? `Static verdict_kind: ${outcome.evidence.verdict_kind}`
      : `Static replay unavailable: ${outcome.failure.summary}`,
  ];

  return buildFullReplayOutcome({
    lines,
    pass,
    rederived_verdict: rederived,
    recorded_verdict: recorded,
  });
}

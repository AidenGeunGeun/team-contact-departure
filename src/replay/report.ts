import type { ReplayOutcome } from "./types.js";

export function formatReplayReport(
  manifest: { runner_kind: string; bundle_id: string; replay_kind: string },
  outcome: ReplayOutcome,
): string {
  return [
    `Bundle: ${manifest.bundle_id}`,
    `Runner kind: ${manifest.runner_kind}`,
    `Replay kind: ${manifest.replay_kind}`,
    "",
    ...outcome.lines,
    "",
    outcome.pass ? "PASS" : "FAIL",
  ].join("\n");
}

/** Full / trivial replay: verdict was re-derived from re-execution or deterministic logic. */
export function buildFullReplayOutcome(input: {
  lines: string[];
  pass: boolean;
  rederived_verdict: string;
  recorded_verdict: string;
}): ReplayOutcome {
  return {
    lines: [
      ...input.lines,
      `Recorded verdict: ${input.recorded_verdict}`,
      `Rederived verdict: ${input.rederived_verdict}`,
      input.pass ? "Verdict match: yes" : "Verdict match: no",
    ],
    pass: input.pass,
    rederived_verdict: input.rederived_verdict,
  };
}

/** Partial replay: bundled record and re-evaluable signals only; runtime not re-executed. */
export function buildPartialReplayOutcome(input: {
  lines: string[];
  pass: boolean;
  recorded_verdict: string;
  integrity_note: string;
}): ReplayOutcome {
  return {
    lines: [
      ...input.lines,
      `Recorded verdict: ${input.recorded_verdict}`,
      "Verdict not re-derived; runtime re-execution requires environment.",
      `Bundled record check: ${input.integrity_note}`,
    ],
    pass: input.pass,
    rederived_verdict: "not_rederived",
  };
}

/** Replay refused before re-execution (pinned input mismatch, missing deps). */
export function buildRefusedReplayOutcome(input: {
  lines: string[];
  recorded_verdict: string;
}): ReplayOutcome {
  return {
    lines: [
      ...input.lines,
      `Recorded verdict: ${input.recorded_verdict}`,
      "Replay refused: pinned inputs could not be verified; verdict was not re-derived.",
    ],
    pass: false,
    rederived_verdict: "replay_refused",
  };
}

/** @deprecated Use buildFullReplayOutcome or buildPartialReplayOutcome */
export function buildReplayOutcome(input: {
  lines: string[];
  pass: boolean;
  rederived_verdict: string;
  recorded_verdict: string;
}): ReplayOutcome {
  return buildFullReplayOutcome(input);
}

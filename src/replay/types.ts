import type { RunnerKind } from "../domain/jobs.js";

export type ReplayKind = "full" | "partial" | "trivial";

export interface BundleRecordedResult {
  verdict: string;
  outcome?: string;
  confidence?: string;
  summary?: string;
}

export interface BundleManifest {
  schema_version: 1;
  bundle_id: string;
  created_at: string;
  runner_kind: RunnerKind | "pair";
  job_id?: string;
  pair_id?: string;
  case_id: string;
  test_card_id: string;
  target_commit: string;
  budget_profile: string;
  pinned_inputs: Record<string, string | number | boolean>;
  recorded_result: BundleRecordedResult;
  replay_kind: ReplayKind;
  replay_kind_reason: string;
  replay_command: string;
  artifact_paths: string[];
}

export interface ReplayOutcome {
  lines: string[];
  pass: boolean;
  rederived_verdict: string;
}

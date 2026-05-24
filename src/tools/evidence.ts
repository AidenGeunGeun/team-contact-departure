import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { listCases, listTestCards, loadCase, type CaseSummary, type CuratedCase, type TestCard } from "../domain/catalog.js";
import {
  cancelJob,
  inspectJob,
  launchEvidenceJob,
  type CancelJobInput,
  type InspectJobInput,
  type JobCancellationDetails,
  type JobInspectionDetails,
  type JobLaunchDetails,
  type LaunchEvidenceJobInput,
} from "../domain/jobs.js";
import {
  compareEvidencePair,
  type CompareEvidencePairDetails,
  type CompareEvidencePairInput,
} from "../domain/evidence-pair.js";
import {
  createEvidenceBundle,
  type CreateEvidenceBundleDetails,
  type CreateEvidenceBundleInput,
} from "../domain/evidence-bundle.js";

const emptySchema = Type.Object({});

const loadCaseSchema = Type.Object({
  case_id: Type.String({ description: "Curated case id returned by list_cases." }),
});

const launchEvidenceJobSchema = Type.Object({
  case_id: Type.String({ description: "Curated case id returned by list_cases." }),
  test_card_id: Type.String({ description: "Test card id returned by list_test_cards." }),
  target_commit: Type.String({ description: "Target commit, branch, or demo string to evaluate." }),
  budget_profile: Type.Optional(Type.String({ description: "Optional runner budget label (for example smoke-fast). Defaults to smoke-fast." })),
});

const jobIdSchema = Type.Object({
  job_id: Type.String({ description: "Evidence job id returned by launch_evidence_job." }),
});

const compareEvidencePairSchema = Type.Object({
  job_id_a: Type.String({ description: "First completed evidence job id." }),
  job_id_b: Type.String({ description: "Second completed evidence job id." }),
});

const createEvidenceBundleSchema = Type.Object({
  job_id: Type.Optional(Type.String({ description: "Completed evidence job id to package." })),
  pair_id: Type.Optional(Type.String({ description: "Evidence pair id to package (includes both jobs)." })),
});

export type ListCasesInput = Static<typeof emptySchema>;
export type LoadCaseInput = Static<typeof loadCaseSchema>;
export type ListTestCardsInput = Static<typeof emptySchema>;
export type LaunchEvidenceJobToolInput = Static<typeof launchEvidenceJobSchema>;
export type InspectJobToolInput = Static<typeof jobIdSchema>;
export type CancelJobToolInput = Static<typeof jobIdSchema>;
export type CompareEvidencePairToolInput = Static<typeof compareEvidencePairSchema>;
export type CreateEvidenceBundleToolInput = Static<typeof createEvidenceBundleSchema>;

export interface ListCasesDetails {
  cases: CaseSummary[];
}

export interface LoadCaseDetails {
  case: CuratedCase;
}

export interface ListTestCardsDetails {
  test_cards: TestCard[];
}

export const DOMAIN_TOOL_NAMES = [
  "list_cases",
  "load_case",
  "list_test_cards",
  "launch_evidence_job",
  "inspect_job",
  "cancel_job",
  "compare_evidence_pair",
  "create_evidence_bundle",
] as const;

function textResult<T>(text: string, details: T): AgentToolResult<T> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

function formatCases(cases: CaseSummary[]): string {
  return [
    "Available curated cases:",
    ...cases.map((item) => `- ${item.id}: ${item.title} - ${item.short_description}`),
  ].join("\n");
}

function formatCase(item: CuratedCase): string {
  return [
    `Case ${item.id}: ${item.title}`,
    `Source: ${item.source_citation}`,
    `Target family: ${item.target_family}`,
    "Constraints:",
    ...item.constraints.map((constraint) => `- ${constraint}`),
    "Exact doc snippet:",
    `"${item.doc_snippet}"`,
  ].join("\n");
}

function formatTestCards(cards: TestCard[]): string {
  return [
    "Available test cards:",
    ...cards.map((card) =>
      [
        `- ${card.id}: ${card.title}`,
        `  Use: ${card.plain_language_use}`,
        `  Conceptual run: ${card.conceptual_run}`,
        `  Evidence signals: ${card.evidence_signals.join("; ")}`,
      ].join("\n"),
    ),
  ].join("\n");
}

function formatLaunch(details: JobLaunchDetails): string {
  const lines = [
    `Launched evidence job ${details.job_id}.`,
    `Initial state: ${details.state} (${details.phase}, ${details.progress}%).`,
    `Run folder: ${details.run_dir}`,
    `Artifact folder: ${details.artifact_dir}`,
  ];
  if (details.runner?.process) {
    lines.push(`Runner process: pid ${details.runner.process.pid} (${details.runner.process.entrypoint}).`);
  }
  lines.push("Use inspect_job with the job_id to view progress and results.");
  return lines.join("\n");
}

function formatInspection(details: JobInspectionDetails): string {
  const lines = [
    `Job ${details.job_id} is ${details.state} (${details.phase}, ${details.progress}%).`,
    details.message,
    `Run folder: ${details.run_dir}`,
    `Artifact folder: ${details.artifact_dir}`,
  ];

  if (details.runner?.process) {
    lines.push(`Runner process: pid ${details.runner.process.pid} (${details.runner.process.entrypoint}).`);
  }

  if (details.recent_events.length > 0) {
    lines.push("Recent events:");
    lines.push(
      ...details.recent_events.map(
        (event) => `- ${event.timestamp}: ${event.state}/${event.phase} ${event.progress}% - ${event.message}`,
      ),
    );
  }

  if (details.result) {
    lines.push(`Verdict: ${details.result.verdict} (${details.result.confidence} confidence).`);
    if (details.result.runner_kind) {
      lines.push(`Runner kind: ${details.result.runner_kind}`);
    }
    if (details.result.static_source) {
      const ss = details.result.static_source;
      lines.push(`Static-source verdict_kind: ${ss.verdict_kind}`);
      lines.push(`Resolved commit hash: ${ss.resolved_commit_hash}`);
      lines.push(`Inspected file: ${ss.target_file}`);
      lines.push(`Inspected function: ${ss.target_function}`);
      if (ss.source_region) {
        lines.push(`Inspected line range: ${ss.source_region.start_line}-${ss.source_region.end_line}`);
      }
      if (ss.diff_pre_hash && ss.diff_post_hash) {
        lines.push(`Diff pair: ${ss.diff_pre_hash} -> ${ss.diff_post_hash}`);
      }
      if (ss.pr_url) {
        lines.push(`Reference PR: ${ss.pr_url}`);
      }
    }
    lines.push(`Summary: ${details.result.summary}`);
    if (details.result.artifact_paths.length > 0) {
      lines.push("Artifact paths:");
      lines.push(...details.result.artifact_paths.map((pathName) => `- ${pathName}`));
    }
    if (details.result.cautions.length > 0) {
      lines.push("Cautions:");
      lines.push(...details.result.cautions.map((caution) => `- ${caution}`));
    }
  }

  return lines.join("\n");
}

function formatCancellation(details: JobCancellationDetails): string {
  if (details.cancel_action === "already_terminal") {
    return `Job ${details.job_id} was already terminal (${details.state}). ${details.message}`;
  }
  return `Job ${details.job_id} is now ${details.state}. ${details.message}`;
}

function formatEvidencePairComparison(details: CompareEvidencePairDetails): string {
  const { pair } = details;
  const demonstrated = pair.verdict_flip_demonstrated === true;
  const lines = [
    `Stored evidence pair ${details.pair_id}.`,
    `Pair artifact: ${details.pair_path}`,
    `Case: ${pair.case_id} (${pair.test_card_id})`,
    "",
    demonstrated
      ? "Verdict flip demonstrated: yes — both sides ran the same recipe with proven firmware, delivered frames, and meaningful differing runtime outcomes."
      : "Verdict flip demonstrated: no — the pair artifact was stored, but the full flip claim is not supported by the recorded conditions.",
    "",
    "Supporting conditions:",
    `- outcomes differ: ${pair.outcomes_differ ? "yes" : "no"}`,
    `- provenance complete: ${pair.provenance_complete ? "yes" : "no"}`,
    `- frame bytes equal: ${pair.frame_bytes_equal ? "yes" : "no"}`,
    `- budget profile equal: ${pair.budget_profile_equal ? "yes" : "no"}`,
    `- frames delivered on both sides: ${pair.frames_delivered_on_both_sides ? "yes" : "no"}`,
    `- meaningful outcomes on both sides: ${pair.meaningful_outcomes_on_both_sides ? "yes" : "no"}`,
    "",
    "Pre-patch job:",
    `- job_id: ${pair.pre_patch.job_id}`,
    `- budget_profile: ${pair.pre_patch.budget_profile ?? "unknown"}`,
    `- resolved commit: ${pair.pre_patch.resolved_commit_hash ?? "unknown"}`,
    `- outcome: ${pair.pre_patch.outcome ?? "unknown"}`,
    `- frame delivered: ${pair.pre_patch.frame_delivered ?? "unknown"}`,
    `- firmware_commit_proven: ${pair.pre_patch.firmware_commit_proven ?? "unknown"}`,
    "",
    "Post-patch job:",
    `- job_id: ${pair.post_patch.job_id}`,
    `- budget_profile: ${pair.post_patch.budget_profile ?? "unknown"}`,
    `- resolved commit: ${pair.post_patch.resolved_commit_hash ?? "unknown"}`,
    `- outcome: ${pair.post_patch.outcome ?? "unknown"}`,
    `- frame delivered: ${pair.post_patch.frame_delivered ?? "unknown"}`,
    `- firmware_commit_proven: ${pair.post_patch.firmware_commit_proven ?? "unknown"}`,
    "",
    `Resolved commit hashes differ: ${pair.resolved_commit_hashes_differ ? "yes" : "no"}`,
  ];
  return lines.join("\n");
}

export async function runListCases(): Promise<AgentToolResult<ListCasesDetails>> {
  const cases = await listCases();
  return textResult(formatCases(cases), { cases });
}

export async function runLoadCase(params: LoadCaseInput): Promise<AgentToolResult<LoadCaseDetails>> {
  const selectedCase = await loadCase(params.case_id);
  return textResult(formatCase(selectedCase), { case: selectedCase });
}

export async function runListTestCards(): Promise<AgentToolResult<ListTestCardsDetails>> {
  const testCards = await listTestCards();
  return textResult(formatTestCards(testCards), { test_cards: testCards });
}

export async function runLaunchEvidenceJob(
  params: LaunchEvidenceJobInput,
): Promise<AgentToolResult<JobLaunchDetails>> {
  const details = await launchEvidenceJob(params);
  return textResult(formatLaunch(details), details);
}

export async function runInspectJob(params: InspectJobInput): Promise<AgentToolResult<JobInspectionDetails>> {
  const details = await inspectJob(params);
  return textResult(formatInspection(details), details);
}

export async function runCancelJob(params: CancelJobInput): Promise<AgentToolResult<JobCancellationDetails>> {
  const details = await cancelJob(params);
  return textResult(formatCancellation(details), details);
}

export async function runCompareEvidencePair(
  params: CompareEvidencePairInput,
): Promise<AgentToolResult<CompareEvidencePairDetails>> {
  const details = await compareEvidencePair(params);
  return textResult(formatEvidencePairComparison(details), details);
}

function formatEvidenceBundle(details: CreateEvidenceBundleDetails): string {
  return [
    `Created evidence bundle ${details.bundle_id}.`,
    `Bundle path: ${details.bundle_path}`,
    `Runner kind: ${details.runner_kind}`,
    `Replay kind: ${details.replay_kind}`,
    "",
    "Reviewer replay command (no LLM in the loop):",
    details.replay_command,
    "",
    "Share the bundle directory and replay command with reviewers. Replay re-derives the recorded verdict; partial replay kinds verify artifacts only.",
  ].join("\n");
}

export async function runCreateEvidenceBundle(
  params: CreateEvidenceBundleInput,
): Promise<AgentToolResult<CreateEvidenceBundleDetails>> {
  const details = await createEvidenceBundle(params);
  return textResult(formatEvidenceBundle(details), details);
}

export const listCasesTool = defineTool<typeof emptySchema, ListCasesDetails>({
  name: "list_cases",
  label: "list cases",
  description: "List curated Contact Departure evidence cases by id, title, and short description.",
  promptSnippet: "Browse the curated Contact Departure case catalog before choosing a case.",
  parameters: emptySchema,
  executionMode: "parallel",
  async execute() {
    return runListCases();
  },
});

export const loadCaseTool = defineTool<typeof loadCaseSchema, LoadCaseDetails>({
  name: "load_case",
  label: "load case",
  description: "Load one curated case with its exact public-doc snippet, source citation, target family, and constraints.",
  promptSnippet: "Read the exact snippet and constraints for a selected curated case.",
  parameters: loadCaseSchema,
  executionMode: "parallel",
  async execute(_toolCallId, params) {
    return runLoadCase(params);
  },
});

export const listTestCardsTool = defineTool<typeof emptySchema, ListTestCardsDetails>({
  name: "list_test_cards",
  label: "list test cards",
  description: "List plain-language fake-runner methodology cards and their evidence signals.",
  promptSnippet: "Browse available methodology cards before launching an evidence job.",
  parameters: emptySchema,
  executionMode: "parallel",
  async execute() {
    return runListTestCards();
  },
});

export const launchEvidenceJobTool = defineTool<typeof launchEvidenceJobSchema, JobLaunchDetails>({
  name: "launch_evidence_job",
  label: "launch evidence job",
  description:
    "Launch a non-blocking evidence job for a curated case and test card. The selected case picks the runner: static-source evidence (PX4 checkout analysis), MAVLink parser-library fuzz, PX4 SITL runtime probe, or fake smoke evidence.",
  promptSnippet: "Start an evidence job and keep the returned job_id for inspection or cancellation.",
  parameters: launchEvidenceJobSchema,
  executionMode: "parallel",
  async execute(_toolCallId, params) {
    return runLaunchEvidenceJob(params as LaunchEvidenceJobInput);
  },
});

export const inspectJobTool = defineTool<typeof jobIdSchema, JobInspectionDetails>({
  name: "inspect_job",
  label: "inspect job",
  description: "Inspect an evidence job's lifecycle state, progress, recent events, result, runner kind, and artifact paths.",
  promptSnippet: "Poll a launched job until it reaches a terminal state before summarizing evidence.",
  parameters: jobIdSchema,
  executionMode: "parallel",
  async execute(_toolCallId, params) {
    return runInspectJob(params as InspectJobInput);
  },
});

export const cancelJobTool = defineTool<typeof jobIdSchema, JobCancellationDetails>({
  name: "cancel_job",
  label: "cancel job",
  description: "Cancel a running or queued evidence job and report its final state.",
  promptSnippet: "Cancel a launched evidence job when the user asks to stop it.",
  parameters: jobIdSchema,
  executionMode: "parallel",
  async execute(_toolCallId, params) {
    return runCancelJob(params as CancelJobInput);
  },
});

export const createEvidenceBundleTool = defineTool<typeof createEvidenceBundleSchema, CreateEvidenceBundleDetails>({
  name: "create_evidence_bundle",
  label: "create evidence bundle",
  description:
    "Package a completed evidence job or pair into a replayable bundle under bundles/<bundle_id>/. Reads existing artifacts only; does not launch jobs or run replay.",
  promptSnippet: "After a job or pair is terminal, create a bundle and give the reviewer the replay command.",
  parameters: createEvidenceBundleSchema,
  executionMode: "parallel",
  async execute(_toolCallId, params) {
    return runCreateEvidenceBundle(params as CreateEvidenceBundleInput);
  },
});

export const compareEvidencePairTool = defineTool<typeof compareEvidencePairSchema, CompareEvidencePairDetails>({
  name: "compare_evidence_pair",
  label: "compare evidence pair",
  description:
    "Compare two completed evidence jobs from the same case, test card, and budget profile. Reads existing results only, validates roles and frame bytes, and stores a pair.json artifact. Headline field is verdict_flip_demonstrated, with supporting condition booleans recorded for honest review.",
  promptSnippet: "After two replay jobs finish, compare them to capture a verdict-flip pair artifact.",
  parameters: compareEvidencePairSchema,
  executionMode: "parallel",
  async execute(_toolCallId, params) {
    return runCompareEvidencePair(params as CompareEvidencePairInput);
  },
});

export const evidenceTools = [
  listCasesTool,
  loadCaseTool,
  listTestCardsTool,
  launchEvidenceJobTool,
  inspectJobTool,
  cancelJobTool,
  compareEvidencePairTool,
  createEvidenceBundleTool,
];

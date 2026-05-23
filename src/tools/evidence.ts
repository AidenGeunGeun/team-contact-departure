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

const emptySchema = Type.Object({});

const loadCaseSchema = Type.Object({
  case_id: Type.String({ description: "Curated case id returned by list_cases." }),
});

const launchEvidenceJobSchema = Type.Object({
  case_id: Type.String({ description: "Curated case id returned by list_cases." }),
  test_card_id: Type.String({ description: "Test card id returned by list_test_cards." }),
  target_commit: Type.String({ description: "Target commit, branch, or demo string to evaluate." }),
  budget_profile: Type.Optional(Type.String({ description: "Optional fake-runner budget label. Defaults to smoke-fast." })),
});

const jobIdSchema = Type.Object({
  job_id: Type.String({ description: "Evidence job id returned by launch_evidence_job." }),
});

export type ListCasesInput = Static<typeof emptySchema>;
export type LoadCaseInput = Static<typeof loadCaseSchema>;
export type ListTestCardsInput = Static<typeof emptySchema>;
export type LaunchEvidenceJobToolInput = Static<typeof launchEvidenceJobSchema>;
export type InspectJobToolInput = Static<typeof jobIdSchema>;
export type CancelJobToolInput = Static<typeof jobIdSchema>;

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
    `Launched fake evidence job ${details.job_id}.`,
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
  description: "Launch a non-blocking fake evidence job for a curated case and test card.",
  promptSnippet: "Start a fake evidence job and keep the returned job_id for inspection or cancellation.",
  parameters: launchEvidenceJobSchema,
  executionMode: "parallel",
  async execute(_toolCallId, params) {
    return runLaunchEvidenceJob(params as LaunchEvidenceJobInput);
  },
});

export const inspectJobTool = defineTool<typeof jobIdSchema, JobInspectionDetails>({
  name: "inspect_job",
  label: "inspect job",
  description: "Inspect a fake evidence job's lifecycle state, progress, recent events, result, and artifact paths.",
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
  description: "Cancel a running or queued fake evidence job and report its final state.",
  promptSnippet: "Cancel a launched fake evidence job when the user asks to stop it.",
  parameters: jobIdSchema,
  executionMode: "parallel",
  async execute(_toolCallId, params) {
    return runCancelJob(params as CancelJobInput);
  },
});

export const evidenceTools = [
  listCasesTool,
  loadCaseTool,
  listTestCardsTool,
  launchEvidenceJobTool,
  inspectJobTool,
  cancelJobTool,
];

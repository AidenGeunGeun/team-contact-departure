import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type AgentRunStatus = "succeeded" | "failed";

export interface AgentRunSummary {
  run_id: string;
  prompt: string;
  started_at: string;
  completed_at: string;
  status: AgentRunStatus;
  error_message?: string;
  job_ids: string[];
  run_dir: string;
}

export interface AgentRunRecorderOptions {
  cwd?: string;
  runId?: string;
  prompt: string;
}

interface ToolActivityEntry {
  toolName: string;
  args: unknown;
  updates: unknown[];
  result?: unknown;
  isError?: boolean;
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

const JOB_ID_PATTERN = /job-[A-Za-z0-9_-]+/g;

function extractJobIdsFromValue(value: unknown): string[] {
  if (typeof value === "string") {
    return [...new Set(value.match(JOB_ID_PATTERN) ?? [])];
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const chunks = [
      record.stdout,
      record.output,
      record.details,
      record.job_id,
    ]
      .filter((entry): entry is string => typeof entry === "string")
      .join("\n");
    return [...new Set(chunks.match(JOB_ID_PATTERN) ?? [])];
  }
  return [];
}

function extractJobId(toolName: string, args: unknown, result: unknown): string | undefined {
  if (toolName === "launch_evidence_job" && result && typeof result === "object" && "job_id" in result) {
    const jobId = (result as { job_id?: unknown }).job_id;
    return typeof jobId === "string" ? jobId : undefined;
  }
  if (toolName === "inspect_job" && args && typeof args === "object" && "job_id" in args) {
    const jobId = (args as { job_id?: unknown }).job_id;
    return typeof jobId === "string" ? jobId : undefined;
  }
  if (toolName === "bash") {
    const fromResult = extractJobIdsFromValue(result);
    if (fromResult.length > 0) {
      return fromResult[0];
    }
    const command =
      typeof args === "string"
        ? args
        : args && typeof args === "object" && "command" in args
          ? (args as { command?: unknown }).command
          : undefined;
    const fromCommand = typeof command === "string" ? extractJobIdsFromValue(command) : [];
    return fromCommand[0];
  }
  return undefined;
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export class AgentRunRecorder {
  readonly runId: string;
  readonly runDir: string;
  readonly prompt: string;
  readonly startedAt: Date;

  private assistantText = "";
  private thinkingText = "";
  private toolActivity: ToolActivityEntry[] = [];
  private activeToolByCallId = new Map<string, ToolActivityEntry>();
  private jobIds = new Set<string>();

  constructor(options: AgentRunRecorderOptions) {
    const cwd = options.cwd ?? process.cwd();
    this.startedAt = new Date();
    this.runId = options.runId ?? formatTimestamp(this.startedAt);
    this.prompt = options.prompt;
    this.runDir = join(cwd, "agent-runs", this.runId);
    mkdirSync(this.runDir, { recursive: true });
  }

  appendAssistantText(delta: string): void {
    this.assistantText += delta;
  }

  appendThinkingText(delta: string): void {
    this.thinkingText += delta;
  }

  recordToolStart(toolCallId: string, toolName: string, args: unknown): void {
    const entry: ToolActivityEntry = { toolName, args, updates: [] };
    this.toolActivity.push(entry);
    this.activeToolByCallId.set(toolCallId, entry);
  }

  recordToolUpdate(toolCallId: string, partialResult: unknown): void {
    const entry = this.activeToolByCallId.get(toolCallId);
    if (entry) {
      entry.updates.push(partialResult);
    }
  }

  recordToolEnd(toolCallId: string, toolName: string, result: unknown, isError: boolean): void {
    let entry = this.activeToolByCallId.get(toolCallId);
    if (!entry) {
      entry = { toolName, args: {}, updates: [] };
      this.toolActivity.push(entry);
    }
    entry.result = result;
    entry.isError = isError;
    this.activeToolByCallId.delete(toolCallId);

    const jobId = extractJobId(toolName, entry.args, result);
    if (jobId) {
      this.jobIds.add(jobId);
    }
  }

  noteJobId(jobId: string): void {
    this.jobIds.add(jobId);
  }

  buildTranscript(completedAt: Date, status: AgentRunStatus, errorMessage?: string): string {
    const lines = [
      "# Contact Departure Agent Run",
      "",
      `- Run ID: ${this.runId}`,
      `- Started: ${this.startedAt.toISOString()}`,
      `- Completed: ${completedAt.toISOString()}`,
      `- Status: ${status}`,
    ];

    if (errorMessage) {
      lines.push(`- Error: ${errorMessage}`);
    }

    lines.push("", "## User Prompt", "", this.prompt, "", "## Tool Activity", "");

    if (this.toolActivity.length === 0) {
      lines.push("_No tool calls recorded._");
    } else {
      for (const entry of this.toolActivity) {
        lines.push(`### ${entry.toolName}`, "");
        lines.push("Arguments:", "", "```json", formatJson(entry.args), "```", "");
        if (entry.updates.length > 0) {
          lines.push("Progress updates:", "", "```json", formatJson(entry.updates), "```", "");
        }
        if (entry.result !== undefined) {
          lines.push(`Result${entry.isError ? " (error)" : ""}:`, "", "```json", formatJson(entry.result), "```", "");
        }
      }
    }

    if (this.thinkingText.trim()) {
      lines.push("## Thinking", "", this.thinkingText.trim(), "");
    }

    lines.push("## Final Answer", "", this.assistantText.trim() || "_No assistant answer recorded._", "");
    return lines.join("\n");
  }

  buildSummary(completedAt: Date, status: AgentRunStatus, errorMessage?: string): AgentRunSummary {
    return {
      run_id: this.runId,
      prompt: this.prompt,
      started_at: this.startedAt.toISOString(),
      completed_at: completedAt.toISOString(),
      status,
      ...(errorMessage ? { error_message: errorMessage } : {}),
      job_ids: [...this.jobIds].sort(),
      run_dir: this.runDir,
    };
  }

  writeArtifacts(completedAt: Date, status: AgentRunStatus, errorMessage?: string): AgentRunSummary {
    const summary = this.buildSummary(completedAt, status, errorMessage);
    writeFileSync(join(this.runDir, "transcript.md"), this.buildTranscript(completedAt, status, errorMessage), "utf8");
    writeFileSync(join(this.runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    return summary;
  }
}

export function createStubAgentRun(cwd: string): AgentRunSummary {
  const recorder = new AgentRunRecorder({
    cwd,
    runId: "smoke-operator-stub",
    prompt: "Stub operator run for transcript formatting validation.",
  });

  recorder.recordToolStart("stub-list", "list_cases", {});
  recorder.recordToolEnd("stub-list", "list_cases", { cases: [{ id: "mavlink-battery-status-bounds" }] }, false);
  recorder.recordToolStart("stub-launch", "launch_evidence_job", {
    case_id: "mavlink-battery-status-bounds",
    test_card_id: "mavlink-parser-bounds",
    target_commit: "mavlink-battery-status-bounds-post",
  });
  recorder.recordToolEnd(
    "stub-launch",
    "launch_evidence_job",
    { job_id: "job-stub-001", state: "queued" },
    false,
  );
  recorder.appendAssistantText(
    "This is a stub summary. Static-source evidence only; runtime SITL/fuzzing was not verified.",
  );

  const completedAt = new Date();
  return recorder.writeArtifacts(completedAt, "succeeded");
}

export function validateAgentRunSummary(summary: AgentRunSummary): void {
  const requiredKeys: Array<keyof AgentRunSummary> = [
    "run_id",
    "prompt",
    "started_at",
    "completed_at",
    "status",
    "job_ids",
    "run_dir",
  ];
  for (const key of requiredKeys) {
    if (summary[key] === undefined || summary[key] === null) {
      throw new Error(`summary.json missing required field: ${key}`);
    }
  }
  if (summary.status !== "succeeded" && summary.status !== "failed") {
    throw new Error(`summary.json has invalid status: ${String(summary.status)}`);
  }
  if (!Array.isArray(summary.job_ids)) {
    throw new Error("summary.json job_ids must be an array");
  }
}

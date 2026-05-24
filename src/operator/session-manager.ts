import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { AGENT_AUTH_INSTRUCTION, isAuthErrorMessage } from "../agent/run.js";
import { AgentRunRecorder } from "../agent/transcript.js";
import { CANONICAL_DEMO_PROMPT } from "../agent/prompts.js";
import { createContactDepartureSession } from "../session.js";
import { inspectJob } from "../domain/jobs.js";
import { extractJobIdsFromText, summarizeContactCli, summarizePrimitiveTool } from "./contact-cli.js";
import type { OperatorEvent, OperatorSessionPhase, OperatorSessionState } from "./types.js";

type SseClient = {
  id: string;
  response: ServerResponse;
};

let eventCounter = 0;

function nextEventId(): string {
  eventCounter += 1;
  return `evt-${eventCounter}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function terminalState(state: string | undefined): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

export class OperatorSessionManager {
  private clients = new Map<string, SseClient>();
  private sessionId: string | null = null;
  private phase: OperatorSessionPhase = "idle";
  private prompt: string | undefined;
  private runId: string | undefined;
  private runDir: string | undefined;
  private startedAt: string | undefined;
  private completedAt: string | undefined;
  private errorMessage: string | undefined;
  private authRecovery: string | undefined;
  private modelFallbackMessage: string | undefined;
  private activeJobIds = new Set<string>();
  private selectedJobId: string | undefined;
  private jobPollTimer: NodeJS.Timeout | undefined;
  private lastJobSnapshot = new Map<string, string>();
  private runPromise: Promise<void> | undefined;
  private toolArgsByCallId = new Map<string, unknown>();

  getState(): OperatorSessionState {
    return {
      session_id: this.sessionId,
      phase: this.phase,
      prompt: this.prompt,
      run_id: this.runId,
      run_dir: this.runDir,
      started_at: this.startedAt,
      completed_at: this.completedAt,
      error_message: this.errorMessage,
      auth_recovery: this.authRecovery,
      model_fallback_message: this.modelFallbackMessage,
      active_job_ids: [...this.activeJobIds],
      selected_job_id: this.selectedJobId,
    };
  }

  isBusy(): boolean {
    return this.phase === "starting" || this.phase === "running";
  }

  subscribe(response: ServerResponse): string {
    const clientId = randomUUID();
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    response.write(": connected\n\n");
    this.clients.set(clientId, { id: clientId, response });
    this.emitToClient(clientId, {
      id: nextEventId(),
      session_id: this.sessionId ?? "none",
      timestamp: nowIso(),
      type: "session_ready",
      payload: { state: this.getState() },
    });
    response.on("close", () => {
      this.clients.delete(clientId);
    });
    return clientId;
  }

  async submitPrompt(prompt: string, options: { stub?: boolean } = {}): Promise<{ accepted: boolean; reason?: string }> {
    const trimmed = prompt.trim();
    if (!trimmed) {
      return { accepted: false, reason: "empty_prompt" };
    }
    if (this.isBusy()) {
      return { accepted: false, reason: "session_busy" };
    }

    this.resetSession(trimmed);
    this.runPromise = options.stub ? this.runStubSession(trimmed) : this.runLiveSession(trimmed);
    void this.runPromise;
    return { accepted: true };
  }

  selectJob(jobId: string | undefined): void {
    this.selectedJobId = jobId;
    this.broadcast({
      id: nextEventId(),
      session_id: this.sessionId ?? "none",
      timestamp: nowIso(),
      type: "evidence_job_updated",
      payload: { selected_job_id: jobId, manual_selection: true },
    });
  }

  private resetSession(prompt: string): void {
    this.sessionId = randomUUID();
    this.phase = "starting";
    this.prompt = prompt;
    this.runId = undefined;
    this.runDir = undefined;
    this.startedAt = nowIso();
    this.completedAt = undefined;
    this.errorMessage = undefined;
    this.authRecovery = undefined;
    this.modelFallbackMessage = undefined;
    this.activeJobIds.clear();
    this.selectedJobId = undefined;
    this.lastJobSnapshot.clear();
    this.toolArgsByCallId.clear();
    this.stopJobPolling();
    this.broadcast({
      id: nextEventId(),
      session_id: this.sessionId,
      timestamp: nowIso(),
      type: "session_started",
      payload: { prompt },
    });
    this.broadcast({
      id: nextEventId(),
      session_id: this.sessionId,
      timestamp: nowIso(),
      type: "user_prompt",
      payload: { prompt },
    });
  }

  private emit(event: OperatorEvent): void {
    this.broadcast(event);
  }

  private broadcast(event: OperatorEvent): void {
    for (const clientId of this.clients.keys()) {
      this.emitToClient(clientId, event);
    }
  }

  private emitToClient(clientId: string, event: OperatorEvent): void {
    const client = this.clients.get(clientId);
    if (!client || client.response.writableEnded) {
      this.clients.delete(clientId);
      return;
    }
    client.response.write(`id: ${event.id}\n`);
    client.response.write(`event: ${event.type}\n`);
    client.response.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  private noteJobId(jobId: string): void {
    if (!jobId) {
      return;
    }
    this.activeJobIds.add(jobId);
    if (!this.selectedJobId) {
      this.selectedJobId = jobId;
    }
    this.startJobPolling();
  }

  private startJobPolling(): void {
    if (this.jobPollTimer) {
      return;
    }
    void this.pollJobs();
    this.jobPollTimer = setInterval(() => {
      void this.pollJobs();
    }, 1200);
  }

  private stopJobPolling(): void {
    if (this.jobPollTimer) {
      clearInterval(this.jobPollTimer);
      this.jobPollTimer = undefined;
    }
  }

  private async pollJobs(): Promise<void> {
    if (this.activeJobIds.size === 0) {
      return;
    }
    for (const jobId of this.activeJobIds) {
      try {
        const detail = await inspectJob({ job_id: jobId });
        const snapshot = JSON.stringify({
          state: detail.state,
          phase: detail.phase,
          progress: detail.progress,
          verdict: detail.result?.verdict,
        });
        if (this.lastJobSnapshot.get(jobId) === snapshot) {
          continue;
        }
        this.lastJobSnapshot.set(jobId, snapshot);
        this.emit({
          id: nextEventId(),
          session_id: this.sessionId ?? "none",
          timestamp: nowIso(),
          type: "evidence_job_updated",
          payload: {
            job_id: jobId,
            state: detail.state,
            phase: detail.phase,
            progress: detail.progress,
            runner_kind: detail.runner?.type ?? detail.result?.runner_kind,
            verdict: detail.result?.verdict,
            confidence: detail.result?.confidence,
            summary: detail.result?.summary,
            caveats: detail.result?.cautions ?? [],
            resolved_commit_hash:
              detail.result?.static_source?.resolved_commit_hash ??
              detail.result?.px4_runtime_replay?.resolved_commit_hash,
            case_id:
              detail.result?.static_source?.case_id ??
              detail.result?.mavlink_parser_fuzz?.case_id ??
              detail.result?.px4_sitl_probe?.case_id ??
              detail.result?.px4_runtime_replay?.case_id,
            terminal: terminalState(detail.state),
          },
        });
      } catch {
        this.emit({
          id: nextEventId(),
          session_id: this.sessionId ?? "none",
          timestamp: nowIso(),
          type: "evidence_job_updated",
          payload: { job_id: jobId, unavailable: true },
        });
      }
    }
  }

  private attachPiEvents(
    session: Awaited<ReturnType<typeof createContactDepartureSession>>["session"],
    recorder: AgentRunRecorder,
  ): void {
    session.subscribe((event: AgentSessionEvent) => {
      const sessionId = this.sessionId ?? "none";
      if (event.type === "tool_execution_start") {
        this.toolArgsByCallId.set(event.toolCallId, event.args);
        const contact = summarizeContactCli(event.args);
        this.emit({
          id: nextEventId(),
          session_id: sessionId,
          timestamp: nowIso(),
          type: "tool_started",
          payload: {
            tool_call_id: event.toolCallId,
            tool_name: event.toolName,
            title: summarizePrimitiveTool(event.toolName, event.args),
            state: "running",
          },
        });
        if (contact) {
          this.emit({
            id: nextEventId(),
            session_id: sessionId,
            timestamp: nowIso(),
            type: "contact_cli",
            payload: { tool_call_id: event.toolCallId, ...contact, state: "running" },
          });
          if (contact.job_id) {
            this.noteJobId(contact.job_id);
            recorder.noteJobId(contact.job_id);
          }
        }
        recorder.recordToolStart(event.toolCallId, event.toolName, event.args);
        return;
      }

      if (event.type === "tool_execution_update") {
        recorder.recordToolUpdate(event.toolCallId, event.partialResult?.details ?? event.partialResult);
        this.emit({
          id: nextEventId(),
          session_id: sessionId,
          timestamp: nowIso(),
          type: "tool_updated",
          payload: {
            tool_call_id: event.toolCallId,
            tool_name: event.toolName,
            detail: summarizePrimitiveTool(event.toolName, event.partialResult),
          },
        });
        return;
      }

      if (event.type === "tool_execution_end") {
        recorder.recordToolEnd(
          event.toolCallId,
          event.toolName,
          event.result?.details ?? event.result,
          event.isError,
        );
        const resultPayload = event.result?.details ?? event.result;
        const toolArgs = this.toolArgsByCallId.get(event.toolCallId);
        this.toolArgsByCallId.delete(event.toolCallId);
        const resultText = typeof resultPayload === "string" ? resultPayload : JSON.stringify(resultPayload ?? {});
        for (const jobId of extractJobIdsFromText(resultText)) {
          this.noteJobId(jobId);
          recorder.noteJobId(jobId);
        }
        this.emit({
          id: nextEventId(),
          session_id: sessionId,
          timestamp: nowIso(),
          type: event.isError ? "tool_failed" : "tool_completed",
          payload: {
            tool_call_id: event.toolCallId,
            tool_name: event.toolName,
            title: summarizePrimitiveTool(event.toolName, resultPayload),
            state: event.isError ? "error" : "completed",
            is_error: event.isError,
          },
        });
        const contactSummary = summarizeContactCli(toolArgs, resultPayload);
        if (contactSummary) {
          this.emit({
            id: nextEventId(),
            session_id: sessionId,
            timestamp: nowIso(),
            type: "contact_cli",
            payload: {
              tool_call_id: event.toolCallId,
              ...contactSummary,
              state: event.isError ? "error" : "completed",
            },
          });
          if (contactSummary.job_id) {
            this.noteJobId(contactSummary.job_id);
            recorder.noteJobId(contactSummary.job_id);
          }
        }
        return;
      }

      if (event.type === "message_update") {
        if (event.assistantMessageEvent.type === "text_start") {
          this.emit({
            id: nextEventId(),
            session_id: sessionId,
            timestamp: nowIso(),
            type: "assistant_text_start",
            payload: {},
          });
        }
        if (event.assistantMessageEvent.type === "text_delta") {
          recorder.appendAssistantText(event.assistantMessageEvent.delta);
          this.emit({
            id: nextEventId(),
            session_id: sessionId,
            timestamp: nowIso(),
            type: "assistant_text_delta",
            payload: { delta: event.assistantMessageEvent.delta },
          });
        }
        if (event.assistantMessageEvent.type === "text_end") {
          this.emit({
            id: nextEventId(),
            session_id: sessionId,
            timestamp: nowIso(),
            type: "assistant_text_end",
            payload: {},
          });
        }
        if (event.assistantMessageEvent.type === "thinking_start") {
          this.emit({
            id: nextEventId(),
            session_id: sessionId,
            timestamp: nowIso(),
            type: "thinking_status",
            payload: { status: "thinking" },
          });
        }
        if (event.assistantMessageEvent.type === "thinking_end") {
          this.emit({
            id: nextEventId(),
            session_id: sessionId,
            timestamp: nowIso(),
            type: "thinking_status",
            payload: { status: "idle" },
          });
        }
      }
    });
  }

  private async runLiveSession(prompt: string): Promise<void> {
    const recorder = new AgentRunRecorder({ prompt });
    this.runId = recorder.runId;
    this.runDir = recorder.runDir;
    let session: Awaited<ReturnType<typeof createContactDepartureSession>>["session"] | undefined;
    let status: "succeeded" | "failed" = "succeeded";

    try {
      this.phase = "running";
      this.emit({
        id: nextEventId(),
        session_id: this.sessionId ?? "none",
        timestamp: nowIso(),
        type: "session_ready",
        payload: { state: this.getState() },
      });

      const created = await createContactDepartureSession({ persistSession: true });
      session = created.session;
      this.modelFallbackMessage = created.modelFallbackMessage;
      if (created.modelFallbackMessage) {
        this.emit({
          id: nextEventId(),
          session_id: this.sessionId ?? "none",
          timestamp: nowIso(),
          type: "thinking_status",
          payload: { status: "model_fallback", message: created.modelFallbackMessage },
        });
      }

      this.attachPiEvents(session, recorder);
      await session.prompt(prompt);
    } catch (error) {
      status = "failed";
      this.errorMessage = error instanceof Error ? error.message : String(error);
      if (isAuthErrorMessage(this.errorMessage)) {
        this.authRecovery = AGENT_AUTH_INSTRUCTION;
      }
      this.phase = "failed";
      this.emit({
        id: nextEventId(),
        session_id: this.sessionId ?? "none",
        timestamp: nowIso(),
        type: "session_failed",
        payload: {
          error_message: this.errorMessage,
          auth_recovery: this.authRecovery,
        },
      });
    } finally {
      session?.dispose();
      this.stopJobPolling();
      this.completedAt = nowIso();
      const summary = recorder.writeArtifacts(new Date(), status, this.errorMessage);
      this.runDir = summary.run_dir;
      this.emit({
        id: nextEventId(),
        session_id: this.sessionId ?? "none",
        timestamp: nowIso(),
        type: "transcript_written",
        payload: {
          run_id: summary.run_id,
          run_dir: summary.run_dir,
          job_ids: summary.job_ids,
          status: summary.status,
        },
      });
      if (this.phase !== "failed") {
        this.phase = status === "succeeded" ? "completed" : "failed";
      }
      this.emit({
        id: nextEventId(),
        session_id: this.sessionId ?? "none",
        timestamp: nowIso(),
        type: "session_completed",
        payload: {
          status,
          state: this.getState(),
        },
      });
    }
  }

  private async runStubSession(prompt: string): Promise<void> {
    const recorder = new AgentRunRecorder({ prompt, runId: "operator-smoke-stub" });
    this.runId = recorder.runId;
    this.runDir = recorder.runDir;
    this.phase = "running";
    const sessionId = this.sessionId ?? "none";

    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "session_ready",
      payload: { state: this.getState(), stub: true },
    });

    await delay(process.env.CONTACT_OPERATOR_SMOKE_STUB === "1" ? 120 : 0);

    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "thinking_status",
      payload: { status: "thinking" },
    });
    await delay(40);

    recorder.recordToolStart("stub-1", "bash", {
      command: "npm run contact -- show mavlink-battery-status-bounds",
    });
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "tool_started",
      payload: {
        tool_call_id: "stub-1",
        tool_name: "bash",
        title: "npm run contact -- show mavlink-battery-status-bounds",
        state: "running",
      },
    });
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "contact_cli",
      payload: {
        tool_call_id: "stub-1",
        operation: "show",
        title: "Show case mavlink-battery-status-bounds",
        case_id: "mavlink-battery-status-bounds",
        state: "running",
      },
    });
    await delay(40);

    recorder.recordToolEnd("stub-1", "bash", { stdout: "Case loaded." }, false);
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "tool_completed",
      payload: { tool_call_id: "stub-1", tool_name: "bash", state: "completed" },
    });

    recorder.recordToolStart("stub-2", "bash", {
      command: "npm run contact -- run mavlink-battery-status-bounds --target post --mode smoke",
    });
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "contact_cli",
      payload: {
        tool_call_id: "stub-2",
        operation: "run",
        title: "Launch evidence job for mavlink-battery-status-bounds",
        job_id: "job-stub-operator-001",
        state: "running",
      },
    });
    this.selectedJobId = "job-stub-operator-001";
    recorder.noteJobId("job-stub-operator-001");
    await delay(40);
    recorder.recordToolEnd(
      "stub-2",
      "bash",
      { stdout: "Launched job-stub-operator-001\nstate: queued" },
      false,
    );
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "tool_completed",
      payload: { tool_call_id: "stub-2", tool_name: "bash", state: "completed" },
    });
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "evidence_job_updated",
      payload: {
        job_id: "job-stub-operator-001",
        state: "running",
        phase: "fetching_source",
        progress: 42,
        runner_kind: "static-source-evidence",
        case_id: "mavlink-battery-status-bounds",
        case_title: "MAVLink battery status parser bounds",
        terminal: false,
        stub: true,
      },
    });
    await delay(40);
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "evidence_job_updated",
      payload: {
        job_id: "job-stub-operator-001",
        state: "succeeded",
        phase: "completed",
        progress: 100,
        runner_kind: "static-source-evidence",
        case_id: "mavlink-battery-status-bounds",
        case_title: "MAVLink battery status parser bounds",
        verdict: "manual_review_needed",
        confidence: "medium",
        summary: "Static PX4 source inspection completed for the post-patch alias.",
        caveats: [
          "Static-source evidence at a pinned PX4 commit only.",
          "Not SITL, parser fuzzing, or runtime MAVLink replay.",
          "Agent judgment is not firmware safety authority.",
        ],
        resolved_commit_hash: "stub-commit-post-patch",
        pr_url: "https://github.com/PX4/PX4-Autopilot/pull/stub-demo",
        artifacts: [
          { name: "evidence-summary.md", type: "markdown" },
          { name: "commit-info.json", type: "json" },
          { name: "source-context.md", type: "markdown" },
          { name: "diff-summary.md", type: "markdown" },
        ],
        terminal: true,
        stub: true,
      },
    });

    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "assistant_text_start",
      payload: {},
    });
    const answer =
      "Static-source evidence is in progress. This run inspects PX4 source at a pinned commit; it is not SITL or runtime replay.";
    for (const delta of chunkText(answer, 18)) {
      recorder.appendAssistantText(delta);
      this.emit({
        id: nextEventId(),
        session_id: sessionId,
        timestamp: nowIso(),
        type: "assistant_text_delta",
        payload: { delta },
      });
      await delay(20);
    }
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "assistant_text_end",
      payload: {},
    });

    this.completedAt = nowIso();
    this.stopJobPolling();
    const summary = recorder.writeArtifacts(new Date(), "succeeded");
    this.runDir = summary.run_dir;
    this.phase = "completed";
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "transcript_written",
      payload: {
        run_id: summary.run_id,
        run_dir: summary.run_dir,
        job_ids: summary.job_ids,
        status: summary.status,
        stub: true,
      },
    });
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "session_completed",
      payload: { status: "succeeded", state: this.getState(), stub: true },
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

export const operatorSessionManager = new OperatorSessionManager();

export function operatorDemoPrompt(): string {
  return CANONICAL_DEMO_PROMPT;
}

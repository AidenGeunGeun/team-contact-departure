import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { AGENT_AUTH_INSTRUCTION, isAuthErrorMessage } from "../agent/run.js";
import { AgentRunRecorder } from "../agent/transcript.js";
import { CANONICAL_DEMO_PROMPT } from "../agent/prompts.js";
import { createContactDepartureSession } from "../session.js";
import { inspectJob } from "../domain/jobs.js";
import { asCommand, extractJobIdsFromText, summarizeContactCli } from "./contact-cli.js";
import { describeToolEnd, describeToolStart, isContactBash } from "./tool-display.js";
import {
  appendOperatorSessionEvent,
  deleteOperatorSession,
  listOperatorSessions,
  readOperatorSessionEvents,
  registerOperatorSessionStart,
  upsertOperatorSession,
} from "./session-history.js";
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
  private readonly cwd = process.cwd();
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
  private thinkingStartedAt: number | null = null;
  private agentSession: Awaited<ReturnType<typeof createContactDepartureSession>>["session"] | undefined;
  private piEventsAttached = false;
  private currentRecorder: AgentRunRecorder | undefined;
  private followUpQueue: string[] = [];
  private sessionStubMode = false;
  private aborted = false;
  private stubAbortController: AbortController | undefined;

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
      follow_up_count: this.followUpQueue.length,
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
    const heartbeat = setInterval(() => {
      if (response.writableEnded) {
        clearInterval(heartbeat);
        return;
      }
      response.write(": ping\n\n");
    }, 15000);
    this.emitToClient(clientId, {
      id: nextEventId(),
      session_id: this.sessionId ?? "none",
      timestamp: nowIso(),
      type: "session_ready",
      payload: { state: this.getState() },
    });
    response.on("close", () => {
      clearInterval(heartbeat);
      this.clients.delete(clientId);
    });
    return clientId;
  }

  async submitPrompt(
    prompt: string,
    options: { stub?: boolean; fresh?: boolean } = {},
  ): Promise<{ accepted: boolean; reason?: string; queued?: boolean }> {
    const trimmed = prompt.trim();
    if (!trimmed) {
      return { accepted: false, reason: "empty_prompt" };
    }
    if (this.isBusy()) {
      if (!this.sessionId) {
        return { accepted: false, reason: "session_busy" };
      }
      this.queueFollowUp(trimmed);
      return { accepted: true, queued: true };
    }

    const wasStubSession = this.sessionStubMode;
    this.sessionStubMode = options.stub === true;
    const continuation = !options.fresh && this.canContinueSession({ stub: options.stub, wasStubSession });
    if (continuation) {
      this.beginTurn(trimmed);
    } else {
      this.resetSession(trimmed);
    }
    this.runPromise = options.stub
      ? this.runStubSession(trimmed, { continuation })
      : this.runLiveTurn(trimmed, continuation);
    void this.runPromise;
    return { accepted: true };
  }

  async abortSession(): Promise<{ aborted: boolean; reason?: string }> {
    if (!this.isBusy()) {
      return { aborted: false, reason: "not_running" };
    }
    this.aborted = true;
    this.stubAbortController?.abort();
    if (this.agentSession) {
      try {
        await this.agentSession.abort();
      } catch {
        // abort may reject once the turn settles
      }
    }
    return { aborted: true };
  }

  private queueFollowUp(prompt: string): void {
    this.followUpQueue.push(prompt);
    this.broadcast({
      id: nextEventId(),
      session_id: this.sessionId ?? "none",
      timestamp: nowIso(),
      type: "user_prompt",
      payload: { prompt, queued: true, queue_position: this.followUpQueue.length },
    });
    this.broadcast({
      id: nextEventId(),
      session_id: this.sessionId ?? "none",
      timestamp: nowIso(),
      type: "follow_up_queued",
      payload: {
        queue_length: this.followUpQueue.length,
        state: this.getState(),
      },
    });
  }

  private drainFollowUpQueue(): void {
    if (this.aborted || this.followUpQueue.length === 0 || this.isBusy()) {
      return;
    }
    const batched = this.followUpQueue.splice(0).join("\n\n");
    void this.submitPrompt(batched, { stub: this.sessionStubMode });
  }

  private canContinueSession(options: { stub?: boolean; wasStubSession?: boolean }): boolean {
    if (this.phase !== "completed" || this.errorMessage) {
      return false;
    }
    if (options.stub) {
      return options.wasStubSession === true;
    }
    return this.agentSession !== undefined;
  }

  listSessions() {
    return listOperatorSessions(this.cwd);
  }

  getSessionEvents(sessionId: string) {
    return readOperatorSessionEvents(this.cwd, sessionId);
  }

  deleteSession(sessionId: string): { deleted: boolean; reason?: string } {
    if (!sessionId) {
      return { deleted: false, reason: "invalid_session" };
    }
    if (this.sessionId === sessionId && this.isBusy()) {
      return { deleted: false, reason: "session_busy" };
    }
    if (!deleteOperatorSession(this.cwd, sessionId)) {
      return { deleted: false, reason: "not_found" };
    }
    if (this.sessionId === sessionId) {
      this.startNewChat();
    }
    return { deleted: true };
  }

  startNewChat(): OperatorSessionState {
    this.agentSession?.dispose();
    this.agentSession = undefined;
    this.piEventsAttached = false;
    this.currentRecorder = undefined;
    this.thinkingStartedAt = null;
    this.phase = "idle";
    this.sessionId = null;
    this.prompt = undefined;
    this.runId = undefined;
    this.runDir = undefined;
    this.completedAt = undefined;
    this.errorMessage = undefined;
    this.authRecovery = undefined;
    this.activeJobIds.clear();
    this.selectedJobId = undefined;
    this.lastJobSnapshot.clear();
    this.toolArgsByCallId.clear();
    this.followUpQueue = [];
    this.sessionStubMode = false;
    this.aborted = false;
    this.stubAbortController = undefined;
    this.stopJobPolling();
    return this.getState();
  }

  selectJob(jobId: string | undefined): void {
    this.selectedJobId = jobId;
    if (this.sessionId) {
      upsertOperatorSession(this.cwd, {
        session_id: this.sessionId,
        selected_job_id: jobId,
        updated_at: nowIso(),
      });
    }
    this.broadcast({
      id: nextEventId(),
      session_id: this.sessionId ?? "none",
      timestamp: nowIso(),
      type: "evidence_job_updated",
      payload: { selected_job_id: jobId, manual_selection: true },
    });
  }

  private resetSession(prompt: string): void {
    this.agentSession?.dispose();
    this.agentSession = undefined;
    this.piEventsAttached = false;
    this.currentRecorder = undefined;
    this.thinkingStartedAt = null;
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
    registerOperatorSessionStart(this.cwd, this.sessionId, prompt, false);
    this.broadcast({
      id: nextEventId(),
      session_id: this.sessionId,
      timestamp: nowIso(),
      type: "session_started",
      payload: { prompt, continuation: false },
    });
    this.broadcast({
      id: nextEventId(),
      session_id: this.sessionId,
      timestamp: nowIso(),
      type: "user_prompt",
      payload: { prompt },
    });
  }

  private beginTurn(prompt: string): void {
    this.phase = "starting";
    this.prompt = prompt;
    this.completedAt = undefined;
    this.errorMessage = undefined;
    this.authRecovery = undefined;
    this.toolArgsByCallId.clear();
    if (this.sessionId) {
      registerOperatorSessionStart(this.cwd, this.sessionId, prompt, true);
    }
    this.broadcast({
      id: nextEventId(),
      session_id: this.sessionId ?? "none",
      timestamp: nowIso(),
      type: "session_started",
      payload: { prompt, continuation: true },
    });
    this.broadcast({
      id: nextEventId(),
      session_id: this.sessionId ?? "none",
      timestamp: nowIso(),
      type: "user_prompt",
      payload: { prompt },
    });
  }

  private emit(event: OperatorEvent): void {
    this.broadcast(event);
  }

  private broadcast(event: OperatorEvent): void {
    if (this.sessionId) {
      appendOperatorSessionEvent(this.cwd, this.sessionId, event);
      if (event.type === "session_completed") {
        const payload = event.payload ?? {};
        upsertOperatorSession(this.cwd, {
          session_id: this.sessionId,
          phase: payload.status === "succeeded" ? "completed" : "failed",
          updated_at: event.timestamp,
          selected_job_id: this.selectedJobId,
        });
      }
      if (event.type === "transcript_written") {
        const runId = typeof event.payload?.run_id === "string" ? event.payload.run_id : undefined;
        if (runId) {
          const sessions = listOperatorSessions(this.cwd);
          const entry = sessions.find((item) => item.session_id === this.sessionId);
          const runIds = entry?.run_ids ?? [];
          if (!runIds.includes(runId)) {
            upsertOperatorSession(this.cwd, {
              session_id: this.sessionId,
              run_ids: [...runIds, runId],
              updated_at: event.timestamp,
            });
          }
        }
      }
    }
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
  ): void {
    session.subscribe((event: AgentSessionEvent) => {
      const sessionId = this.sessionId ?? "none";
      if (event.type === "tool_execution_start") {
        this.toolArgsByCallId.set(event.toolCallId, event.args);
        const contact = summarizeContactCli(event.args);
        const display = describeToolStart(event.toolName, event.args);
        if (!isContactBash(event.args)) {
          this.emit({
            id: nextEventId(),
            session_id: sessionId,
            timestamp: nowIso(),
            type: "tool_started",
            payload: {
              tool_call_id: event.toolCallId,
              tool_name: event.toolName,
              state: "running",
              ...display,
            },
          });
        }
        if (contact) {
          this.emit({
            id: nextEventId(),
            session_id: sessionId,
            timestamp: nowIso(),
            type: "contact_cli",
            payload: {
              tool_call_id: event.toolCallId,
              ...contact,
              state: "running",
              command: asCommand(event.args),
              display_mode: "bash",
            },
          });
          if (contact.job_id) {
            this.noteJobId(contact.job_id);
            this.currentRecorder?.noteJobId(contact.job_id);
          }
        }
        this.currentRecorder?.recordToolStart(event.toolCallId, event.toolName, event.args);
        return;
      }

      if (event.type === "tool_execution_update") {
        this.currentRecorder?.recordToolUpdate(
          event.toolCallId,
          event.partialResult?.details ?? event.partialResult,
        );
        const toolArgs = this.toolArgsByCallId.get(event.toolCallId);
        if (!isContactBash(toolArgs)) {
          const display = describeToolEnd(event.toolName, toolArgs, event.partialResult);
          this.emit({
            id: nextEventId(),
            session_id: sessionId,
            timestamp: nowIso(),
            type: "tool_updated",
            payload: {
              tool_call_id: event.toolCallId,
              tool_name: event.toolName,
              ...display,
            },
          });
        }
        return;
      }

      if (event.type === "tool_execution_end") {
        this.currentRecorder?.recordToolEnd(
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
          this.currentRecorder?.noteJobId(jobId);
        }
        const display = describeToolEnd(event.toolName, toolArgs, resultPayload);
        if (!isContactBash(toolArgs)) {
          this.emit({
            id: nextEventId(),
            session_id: sessionId,
            timestamp: nowIso(),
            type: event.isError ? "tool_failed" : "tool_completed",
            payload: {
              tool_call_id: event.toolCallId,
              tool_name: event.toolName,
              state: event.isError ? "error" : "completed",
              is_error: event.isError,
              ...display,
            },
          });
        }
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
              command: asCommand(toolArgs),
              display_mode: "bash",
              output_preview: display.output_preview,
            },
          });
          if (contactSummary.job_id) {
            this.noteJobId(contactSummary.job_id);
            this.currentRecorder?.noteJobId(contactSummary.job_id);
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
          this.currentRecorder?.appendAssistantText(event.assistantMessageEvent.delta);
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
          this.thinkingStartedAt = Date.now();
          this.emit({
            id: nextEventId(),
            session_id: sessionId,
            timestamp: nowIso(),
            type: "thinking_status",
            payload: { status: "thinking" },
          });
        }
        if (event.assistantMessageEvent.type === "thinking_delta") {
          return;
        }
        if (event.assistantMessageEvent.type === "thinking_end") {
          const durationMs =
            this.thinkingStartedAt !== null ? Date.now() - this.thinkingStartedAt : undefined;
          this.thinkingStartedAt = null;
          this.emit({
            id: nextEventId(),
            session_id: sessionId,
            timestamp: nowIso(),
            type: "thinking_end",
            payload: { duration_ms: durationMs },
          });
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

  private async runLiveTurn(prompt: string, continuation: boolean): Promise<void> {
    const recorder = new AgentRunRecorder({ prompt });
    this.currentRecorder = recorder;
    if (!continuation) {
      this.runId = recorder.runId;
      this.runDir = recorder.runDir;
    }
    let status: "succeeded" | "failed" = "succeeded";
    let interrupted = false;

    try {
      this.phase = "running";
      this.emit({
        id: nextEventId(),
        session_id: this.sessionId ?? "none",
        timestamp: nowIso(),
        type: "session_ready",
        payload: { state: this.getState() },
      });

      if (!continuation) {
        const created = await createContactDepartureSession({ persistSession: true });
        this.agentSession = created.session;
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
        if (!this.piEventsAttached && this.agentSession) {
          this.attachPiEvents(this.agentSession);
          this.piEventsAttached = true;
        }
      }

      if (!this.agentSession) {
        throw new Error("Agent session is not available for continuation.");
      }

      await this.agentSession.prompt(prompt);
    } catch (error) {
      if (this.aborted) {
        interrupted = true;
        status = "succeeded";
        this.phase = "completed";
        this.errorMessage = undefined;
        this.emit({
          id: nextEventId(),
          session_id: this.sessionId ?? "none",
          timestamp: nowIso(),
          type: "session_aborted",
          payload: { state: this.getState() },
        });
      } else {
        status = "failed";
        this.errorMessage = error instanceof Error ? error.message : String(error);
        if (isAuthErrorMessage(this.errorMessage)) {
          this.authRecovery = AGENT_AUTH_INSTRUCTION;
        }
        this.phase = "failed";
        this.agentSession?.dispose();
        this.agentSession = undefined;
        this.piEventsAttached = false;
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
      }
    } finally {
      this.currentRecorder = undefined;
      this.stopJobPolling();
      this.completedAt = nowIso();
      const summary = recorder.writeArtifacts(new Date(), interrupted ? "succeeded" : status, this.errorMessage);
      this.runDir = summary.run_dir;
      if (!continuation || !this.runId) {
        this.runId = summary.run_id;
      }
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
          interrupted,
          state: this.getState(),
        },
      });
      const wasAborted = this.aborted;
      this.aborted = false;
      if (!wasAborted) {
        this.drainFollowUpQueue();
      }
    }
  }

  private async stubDelay(ms: number): Promise<void> {
    await delay(ms, this.stubAbortController?.signal);
  }

  private stubPace(kind: "step" | "quick" | "think" = "step"): number {
    const fast = process.env.CONTACT_OPERATOR_SMOKE_STUB === "1";
    if (kind === "think" || kind === "quick") {
      return fast ? 8 : kind === "think" ? 70 : 55;
    }
    return fast ? 25 : 760;
  }

  private async emitStubAssistantMessage(
    recorder: AgentRunRecorder,
    sessionId: string,
    message: string,
    options: { chunkSize?: number; pace?: "quick" | "think" } = {},
  ): Promise<void> {
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "assistant_text_start",
      payload: {},
    });
    for (const delta of chunkText(message, options.chunkSize ?? 28)) {
      recorder.appendAssistantText(delta);
      this.emit({
        id: nextEventId(),
        session_id: sessionId,
        timestamp: nowIso(),
        type: "assistant_text_delta",
        payload: { delta },
      });
      await this.stubDelay(this.stubPace(options.pace ?? "quick"));
    }
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "assistant_text_end",
      payload: {},
    });
    recorder.appendAssistantText("\n\n");
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof Error && error.message === "Aborted";
  }

  private async finalizeStubTurn(
    recorder: AgentRunRecorder,
    sessionId: string,
    interrupted: boolean,
  ): Promise<void> {
    if (interrupted) {
      this.phase = "completed";
      this.emit({
        id: nextEventId(),
        session_id: sessionId,
        timestamp: nowIso(),
        type: "session_aborted",
        payload: { state: this.getState(), stub: true },
      });
    }
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
      payload: {
        status: "succeeded",
        interrupted,
        state: this.getState(),
        stub: true,
      },
    });
    const wasAborted = this.aborted;
    this.aborted = false;
    if (!wasAborted) {
      this.drainFollowUpQueue();
    }
  }

  private async runStubSession(prompt: string, options: { continuation?: boolean } = {}): Promise<void> {
    const continuation = options.continuation === true;
    if (continuation) {
      await this.runStubContinuationTurn(prompt);
      return;
    }

    this.stubAbortController = new AbortController();
    const recorder = new AgentRunRecorder({ prompt, runId: "operator-smoke-stub" });
    this.runId = recorder.runId;
    this.runDir = recorder.runDir;
    this.phase = "running";
    const sessionId = this.sessionId ?? "none";

    try {
      await this.runStubSessionBody(recorder, sessionId);
      await this.finalizeStubTurn(recorder, sessionId, false);
    } catch (error) {
      if (this.aborted || this.isAbortError(error)) {
        await this.finalizeStubTurn(recorder, sessionId, true);
        return;
      }
      throw error;
    } finally {
      this.stubAbortController = undefined;
    }
  }

  private async runStubSessionBody(
    recorder: AgentRunRecorder,
    sessionId: string,
  ): Promise<void> {

    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "session_ready",
      payload: { state: this.getState(), stub: true },
    });

    await this.stubDelay(this.stubPace("quick"));

    this.thinkingStartedAt = Date.now();
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "thinking_status",
      payload: { status: "thinking" },
    });
    const stepDelay = this.stubPace("step");
    await this.stubDelay(this.stubPace("think") * 8);
    const thinkingDurationMs =
      this.thinkingStartedAt !== null ? Date.now() - this.thinkingStartedAt : undefined;
    this.thinkingStartedAt = null;
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "thinking_end",
      payload: { duration_ms: thinkingDurationMs },
    });
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "thinking_status",
      payload: { status: "idle" },
    });
    await this.stubDelay(stepDelay);

    await this.emitStubAssistantMessage(
      recorder,
      sessionId,
      "I’ll handle this like an evidence operator: first identify the claim, then choose a bounded runner, then let artifacts decide what can be said.",
      { chunkSize: 18 },
    );
    await this.stubDelay(stepDelay);

    const casesArgs = { command: "npm run contact -- cases" };
    recorder.recordToolStart("stub-cases", "bash", casesArgs);
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "contact_cli",
      payload: {
        tool_call_id: "stub-cases",
        ...summarizeContactCli(casesArgs)!,
        state: "running",
        command: asCommand(casesArgs),
        display_mode: "bash",
      },
    });
    await this.stubDelay(stepDelay);
    const casesOutput = [
      "mavlink-battery-status-bounds",
      "mavlink-battery-status-runtime-replay",
      "px4-runtime-probe",
      "mavlink-parser-library-fuzz",
    ].join("\n");
    recorder.recordToolEnd("stub-cases", "bash", { stdout: casesOutput }, false);
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "contact_cli",
      payload: {
        tool_call_id: "stub-cases",
        ...summarizeContactCli(casesArgs, { stdout: casesOutput })!,
        state: "completed",
        command: asCommand(casesArgs),
        display_mode: "bash",
        output_preview: "Catalog includes parser-bounds, runtime replay, SITL probe, and parser fuzz cases.",
      },
    });
    await this.emitStubAssistantMessage(
      recorder,
      sessionId,
      "The parser-bounds case is the right starting point for a quick demo: narrow claim, pinned PX4 commits, and artifacts a reviewer can inspect.",
      { chunkSize: 18 },
    );
    await this.stubDelay(stepDelay);

    const stubExplore = [
      { id: "stub-e1", tool: "read", args: { path: "specs/mavlink-battery-status-bounds.md" } },
      { id: "stub-e2", tool: "grep", args: { pattern: "BATTERY_STATUS", path: "src" } },
      { id: "stub-e3", tool: "read", args: { path: "src/px4/parser/battery_status.cpp" } },
      { id: "stub-e4", tool: "read", args: { path: "data/static-source-commits.json" } },
    ];
    for (const step of stubExplore) {
      recorder.recordToolStart(step.id, step.tool, step.args);
      this.emit({
        id: nextEventId(),
        session_id: sessionId,
        timestamp: nowIso(),
        type: "tool_started",
        payload: {
          tool_call_id: step.id,
          tool_name: step.tool,
          state: "running",
          ...describeToolStart(step.tool, step.args),
        },
      });
      await this.stubDelay(stepDelay);
      recorder.recordToolEnd(step.id, step.tool, { details: "ok" }, false);
      this.emit({
        id: nextEventId(),
        session_id: sessionId,
        timestamp: nowIso(),
        type: "tool_completed",
        payload: {
          tool_call_id: step.id,
          tool_name: step.tool,
          state: "completed",
          ...describeToolEnd(step.tool, step.args, { details: "ok" }),
        },
      });
    }
    await this.stubDelay(stepDelay);

    await this.emitStubAssistantMessage(
      recorder,
      sessionId,
      "This maps to static-source evidence first. It will not certify runtime behavior, but it can verify whether the claimed patch structure is present at the pinned commit.",
      { chunkSize: 20 },
    );
    await this.stubDelay(stepDelay);

    const showArgs = { command: "npm run contact -- show mavlink-battery-status-bounds" };
    recorder.recordToolStart("stub-1", "bash", showArgs);
    const showContact = summarizeContactCli(showArgs)!;
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "contact_cli",
      payload: {
        tool_call_id: "stub-1",
        ...showContact,
        state: "running",
        command: asCommand(showArgs),
        display_mode: "bash",
      },
    });
    await this.stubDelay(stepDelay);

    recorder.recordToolEnd("stub-1", "bash", { stdout: "Case loaded." }, false);
    const showEnd = describeToolEnd("bash", showArgs, { stdout: "Case loaded." });
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "contact_cli",
      payload: {
        tool_call_id: "stub-1",
        ...summarizeContactCli(showArgs, { stdout: "Case loaded." })!,
        state: "completed",
        command: asCommand(showArgs),
        display_mode: "bash",
        output_preview: showEnd.output_preview,
      },
    });

    const runArgs = {
      command: "npm run contact -- run mavlink-battery-status-bounds --target post --mode smoke",
    };
    recorder.recordToolStart("stub-2", "bash", runArgs);
    const runContact = summarizeContactCli(runArgs)!;
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "contact_cli",
      payload: {
        tool_call_id: "stub-2",
        ...runContact,
        state: "running",
        command: asCommand(runArgs),
        display_mode: "bash",
      },
    });
    this.selectedJobId = "job-stub-operator-001";
    recorder.noteJobId("job-stub-operator-001");
    await this.stubDelay(stepDelay);
    recorder.recordToolEnd(
      "stub-2",
      "bash",
      { stdout: "Launched job-stub-operator-001\nstate: queued" },
      false,
    );
    const runEnd = describeToolEnd("bash", runArgs, {
      stdout: "Launched job-stub-operator-001\nstate: queued",
    });
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "contact_cli",
      payload: {
        tool_call_id: "stub-2",
        ...summarizeContactCli(runArgs, { stdout: "Launched job-stub-operator-001\nstate: queued" })!,
        state: "completed",
        command: asCommand(runArgs),
        display_mode: "bash",
        output_preview: runEnd.output_preview,
      },
    });
    const watchArgs = { command: "npm run contact -- watch job-stub-operator-001" };
    recorder.recordToolStart("stub-3", "bash", watchArgs);
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "contact_cli",
      payload: {
        tool_call_id: "stub-3",
        ...summarizeContactCli(watchArgs)!,
        state: "running",
        command: asCommand(watchArgs),
        display_mode: "bash",
        output_preview: "job-stub-operator-001 · queued · resolving_commit · 18%",
      },
    });
    await this.stubDelay(stepDelay);
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "evidence_job_updated",
      payload: {
        job_id: "job-stub-operator-001",
        state: "running",
        phase: "resolving_commit",
        progress: 18,
        runner_kind: "static-source-evidence",
        case_id: "mavlink-battery-status-bounds",
        case_title: "MAVLink battery status parser bounds",
        terminal: false,
        stub: true,
      },
    });
    await this.stubDelay(stepDelay);
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "contact_cli",
      payload: {
        tool_call_id: "stub-3",
        ...summarizeContactCli(watchArgs, {
          stdout: "job-stub-operator-001 · running · fetching_source · 42%",
        })!,
        state: "running",
        command: asCommand(watchArgs),
        display_mode: "bash",
        output_preview: "job-stub-operator-001 · running · fetching_source · 42%",
      },
    });
    await this.stubDelay(stepDelay);
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
    await this.stubDelay(stepDelay);
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "contact_cli",
      payload: {
        tool_call_id: "stub-3",
        ...summarizeContactCli(watchArgs, {
          stdout: "job-stub-operator-001 · running · inspecting_source · 78%",
        })!,
        state: "running",
        command: asCommand(watchArgs),
        display_mode: "bash",
        output_preview: "job-stub-operator-001 · running · inspecting_source · 78%",
      },
    });
    await this.stubDelay(stepDelay);
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "evidence_job_updated",
      payload: {
        job_id: "job-stub-operator-001",
        state: "running",
        phase: "locating_function",
        progress: 64,
        runner_kind: "static-source-evidence",
        case_id: "mavlink-battery-status-bounds",
        case_title: "MAVLink battery status parser bounds",
        terminal: false,
        stub: true,
      },
    });
    await this.stubDelay(stepDelay);
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "evidence_job_updated",
      payload: {
        job_id: "job-stub-operator-001",
        state: "running",
        phase: "inspecting_source",
        progress: 78,
        runner_kind: "static-source-evidence",
        case_id: "mavlink-battery-status-bounds",
        case_title: "MAVLink battery status parser bounds",
        terminal: false,
        stub: true,
      },
    });
    await this.stubDelay(stepDelay);
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "evidence_job_updated",
      payload: {
        job_id: "job-stub-operator-001",
        state: "running",
        phase: "checking_guard_order",
        progress: 91,
        runner_kind: "static-source-evidence",
        case_id: "mavlink-battery-status-bounds",
        case_title: "MAVLink battery status parser bounds",
        terminal: false,
        stub: true,
      },
    });
    await this.stubDelay(stepDelay);
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
        verdict: "mitigation_observed",
        confidence: "medium",
        summary: "Static PX4 source inspection found the post-patch guard ordering consistent with the supplier-style mitigation claim.",
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
    const watchDone = describeToolEnd("bash", watchArgs, {
      stdout: "job-stub-operator-001 · succeeded · completed · 100%",
    });
    recorder.recordToolEnd("stub-3", "bash", { stdout: watchDone.output_preview ?? "" }, false);
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "contact_cli",
      payload: {
        tool_call_id: "stub-3",
        ...summarizeContactCli(watchArgs, { stdout: "job-stub-operator-001 · succeeded · completed · 100%" })!,
        state: "completed",
        command: asCommand(watchArgs),
        display_mode: "bash",
        output_preview: watchDone.output_preview,
      },
    });
    await this.stubDelay(stepDelay);

    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "evidence_job_updated",
      payload: {
        selected_job_id: "job-stub-operator-001",
        manual_selection: true,
        auto_open: true,
        stub: true,
      },
    });
    await this.emitStubAssistantMessage(
      recorder,
      sessionId,
      "The evidence job is terminal now. I’m opening the evidence panel so the result, caveats, commit reference, and artifacts are visible before I summarize.",
      { chunkSize: 20 },
    );
    await this.stubDelay(stepDelay);

    const artifactReads = [
      { id: "stub-r1", path: "runs/job-stub-operator-001/evidence-summary.md" },
      { id: "stub-r2", path: "runs/job-stub-operator-001/commit-info.json" },
      { id: "stub-r3", path: "runs/job-stub-operator-001/source-context.md" },
      { id: "stub-r4", path: "runs/job-stub-operator-001/diff-summary.md" },
    ];
    for (const step of artifactReads) {
      recorder.recordToolStart(step.id, "read", step);
      this.emit({
        id: nextEventId(),
        session_id: sessionId,
        timestamp: nowIso(),
        type: "tool_started",
        payload: {
          tool_call_id: step.id,
          tool_name: "read",
          state: "running",
          ...describeToolStart("read", step),
        },
      });
      await this.stubDelay(this.stubPace("quick"));
      recorder.recordToolEnd(step.id, "read", { details: "ok" }, false);
      this.emit({
        id: nextEventId(),
        session_id: sessionId,
        timestamp: nowIso(),
        type: "tool_completed",
        payload: {
          tool_call_id: step.id,
          tool_name: "read",
          state: "completed",
          ...describeToolEnd("read", step, { details: "ok" }),
        },
      });
    }
    await this.stubDelay(stepDelay);

    const judgmentArgs = {
      command:
        "cat > agent-judgments/mavlink-battery-status-bounds-demo.md <<'EOF'\nStatic-source parser-bounds review: mitigation_observed at stub-commit-post-patch, with runtime caveats.\nEOF",
    };
    recorder.recordToolStart("stub-4", "bash", judgmentArgs);
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "contact_cli",
      payload: {
        tool_call_id: "stub-4",
        title: "Write analyst judgment",
        operation: "unknown",
        state: "running",
        command: asCommand(judgmentArgs),
        display_mode: "bash",
      },
    });
    await this.stubDelay(stepDelay);
    recorder.recordToolEnd("stub-4", "bash", { stdout: "Wrote agent-judgments/mavlink-battery-status-bounds-demo.md" }, false);
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "contact_cli",
      payload: {
        tool_call_id: "stub-4",
        title: "Write analyst judgment",
        operation: "unknown",
        state: "completed",
        command: asCommand(judgmentArgs),
        display_mode: "bash",
        output_preview: "Wrote agent-judgments/mavlink-battery-status-bounds-demo.md",
      },
    });
    await this.stubDelay(stepDelay);

    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "assistant_text_start",
      payload: {},
    });
    const answer = [
      "## MAVLink battery status parser-bounds — demo result",
      "",
      "**Job:** `job-stub-operator-001`",
      "**Verdict:** mitigation_observed (medium confidence)",
      "**Runner:** static-source-evidence",
      "**Resolved commit:** `stub-commit-post-patch`",
      "**Inspected:** `src/modules/mavlink/mavlink_messages.cpp` · `BatteryStatus::parse()` · lines 812–889",
      "**PR:** https://github.com/PX4/PX4-Autopilot/pull/stub-demo",
      "",
      "**Artifacts:**",
      "- `runs/job-stub-operator-001/evidence-summary.md`",
      "- `runs/job-stub-operator-001/commit-info.json`",
      "- `runs/job-stub-operator-001/source-context.md`",
      "- `runs/job-stub-operator-001/diff-summary.md`",
      "",
      "**Caveats:**",
      "- Static-source evidence at a pinned PX4 commit only.",
      "- Not SITL, parser fuzzing, or runtime MAVLink replay.",
      "- Agent judgment is not firmware safety authority.",
      "",
      "**Recommended next step:** Run PX4 SITL probe, parser-library fuzz, or the ASan runtime replay to corroborate runtime behavior.",
      "",
      "Analyst judgment saved to `agent-judgments/mavlink-battery-status-bounds-demo.md`.",
      "",
      "This demo stream is simulated; it shows the operator workflow without live Pi or real Contact jobs.",
    ].join("\n");
    await this.emitStubAssistantMessage(recorder, sessionId, answer, { chunkSize: 18 });
  }

  private async runStubContinuationTurn(prompt: string): Promise<void> {
    this.stubAbortController = new AbortController();
    const recorder = new AgentRunRecorder({ prompt });
    this.phase = "running";
    const sessionId = this.sessionId ?? "none";

    try {
      await this.runStubContinuationBody(recorder, sessionId, prompt);
      await this.finalizeStubTurn(recorder, sessionId, false);
    } catch (error) {
      if (this.aborted || this.isAbortError(error)) {
        await this.finalizeStubTurn(recorder, sessionId, true);
        return;
      }
      throw error;
    } finally {
      this.stubAbortController = undefined;
    }
  }

  private async runStubContinuationBody(
    recorder: AgentRunRecorder,
    sessionId: string,
    prompt: string,
  ): Promise<void> {

    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "session_ready",
      payload: { state: this.getState(), stub: true },
    });

    this.thinkingStartedAt = Date.now();
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "thinking_status",
      payload: { status: "thinking" },
    });
    await this.stubDelay(80);
    const thinkingDurationMs =
      this.thinkingStartedAt !== null ? Date.now() - this.thinkingStartedAt : undefined;
    this.thinkingStartedAt = null;
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "thinking_end",
      payload: { duration_ms: thinkingDurationMs },
    });
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "thinking_status",
      payload: { status: "idle" },
    });
    await this.stubDelay(30);

    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "assistant_text_start",
      payload: {},
    });
    const answer = `Continuing the same session. I still have the earlier MAVLink battery status context and your follow-up: “${prompt.slice(0, 160)}”.`;
    for (const delta of chunkText(answer, 24)) {
      recorder.appendAssistantText(delta);
      this.emit({
        id: nextEventId(),
        session_id: sessionId,
        timestamp: nowIso(),
        type: "assistant_text_delta",
        payload: { delta },
      });
      await this.stubDelay(16);
    }
    this.emit({
      id: nextEventId(),
      session_id: sessionId,
      timestamp: nowIso(),
      type: "assistant_text_end",
      payload: {},
    });
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (!signal) {
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      },
      { once: true },
    );
  });
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

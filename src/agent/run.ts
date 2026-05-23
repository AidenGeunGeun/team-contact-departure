import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createContactDepartureSession } from "../session.js";
import { AgentRunRecorder, type AgentRunSummary } from "./transcript.js";

export const AGENT_AUTH_INSTRUCTION =
  "Model-backed agent commands need pi auth for openai-codex. Run `npx pi`, then `/login openai-codex`, then retry.";

export function isAuthErrorMessage(message: string): boolean {
  return /api key|auth|login|unauthorized|forbidden/i.test(message);
}

export interface RunAgentOperatorOptions {
  prompt: string;
  cwd?: string;
  runId?: string;
}

export interface RunAgentOperatorResult {
  summary: AgentRunSummary;
  modelFallbackMessage?: string;
}

function attachSessionRecorder(
  session: Awaited<ReturnType<typeof createContactDepartureSession>>["session"],
  recorder: AgentRunRecorder,
  streamToTerminal: boolean,
): void {
  session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "tool_execution_start") {
      recorder.recordToolStart(event.toolCallId, event.toolName, event.args);
      if (streamToTerminal) {
        console.log(`\n[tool start] ${event.toolName} ${JSON.stringify(event.args)}`);
      }
      return;
    }

    if (event.type === "tool_execution_update") {
      recorder.recordToolUpdate(event.toolCallId, event.partialResult?.details ?? event.partialResult);
      if (streamToTerminal) {
        console.log(
          `\n[tool update] ${event.toolName} ${JSON.stringify(event.partialResult?.details ?? event.partialResult)}`,
        );
      }
      return;
    }

    if (event.type === "tool_execution_end") {
      recorder.recordToolEnd(
        event.toolCallId,
        event.toolName,
        event.result?.details ?? event.result,
        event.isError,
      );
      if (streamToTerminal) {
        console.log(
          `\n[tool end] ${event.toolName} ${JSON.stringify(event.result?.details ?? event.result)}`,
        );
      }
      return;
    }

    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      recorder.appendAssistantText(event.assistantMessageEvent.delta);
      if (streamToTerminal) {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
    }
  });
}

export async function runAgentOperator(options: RunAgentOperatorOptions): Promise<RunAgentOperatorResult> {
  const recorder = new AgentRunRecorder({
    cwd: options.cwd,
    runId: options.runId,
    prompt: options.prompt,
  });

  let session: Awaited<ReturnType<typeof createContactDepartureSession>>["session"] | undefined;
  let modelFallbackMessage: string | undefined;
  let status: "succeeded" | "failed" = "succeeded";
  let errorMessage: string | undefined;

  try {
    const created = await createContactDepartureSession({ persistSession: true });
    session = created.session;
    modelFallbackMessage = created.modelFallbackMessage;
    attachSessionRecorder(session, recorder, true);

    if (modelFallbackMessage) {
      console.warn(modelFallbackMessage);
    }

    try {
      await session.prompt(options.prompt);
      console.log();
    } catch (error) {
      status = "failed";
      errorMessage = error instanceof Error ? error.message : String(error);
      if (isAuthErrorMessage(errorMessage)) {
        console.error(AGENT_AUTH_INSTRUCTION);
      } else {
        console.error(errorMessage);
      }
    }
  } catch (error) {
    status = "failed";
    errorMessage = error instanceof Error ? error.message : String(error);
    if (isAuthErrorMessage(errorMessage)) {
      console.error(AGENT_AUTH_INSTRUCTION);
    } else {
      console.error(errorMessage);
    }
  } finally {
    session?.dispose();
  }

  const summary = recorder.writeArtifacts(new Date(), status, errorMessage);
  console.log(`\nAgent run saved to ${summary.run_dir}`);
  console.log(`- transcript: ${summary.run_dir}/transcript.md`);
  console.log(`- summary: ${summary.run_dir}/summary.json`);

  return { summary, modelFallbackMessage };
}

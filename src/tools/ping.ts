import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const pingSchema = Type.Object({
  message: Type.Optional(Type.String({ description: "Optional message to echo back." })),
});

export type PingInput = Static<typeof pingSchema>;

export interface PingDetails {
  ok: boolean;
  echo: string;
  phase: "started" | "completed";
}

export async function runPing(
  params: PingInput,
  onUpdate?: AgentToolUpdateCallback<PingDetails>,
): Promise<AgentToolResult<PingDetails>> {
  const echo = params.message ?? "pong";
  onUpdate?.({
    content: [{ type: "text", text: `ping started: ${echo}` }],
    details: { ok: true, echo, phase: "started" },
  });

  return {
    content: [{ type: "text", text: `ping completed: ${echo}` }],
    details: { ok: true, echo, phase: "completed" },
  };
}

export const pingTool = defineTool<typeof pingSchema, PingDetails>({
  name: "ping",
  label: "ping",
  description:
    "Smoke-test tool for the Contact Departure harness. Echoes a message and emits one progress update.",
  promptSnippet: "Smoke-test harness wiring with a harmless ping.",
  parameters: pingSchema,
  executionMode: "parallel",
  async execute(_toolCallId, params, _signal, onUpdate) {
    return runPing(params, onUpdate);
  },
});

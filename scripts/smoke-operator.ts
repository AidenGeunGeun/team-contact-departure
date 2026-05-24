import { strict as assert } from "node:assert";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createStubAgentRun,
  validateAgentRunSummary,
  type AgentRunSummary,
} from "../src/agent/transcript.js";
import { extractJobIdsFromText, summarizeContactCli } from "../src/operator/contact-cli.js";
import { startDashboardServer } from "../src/dashboard/server.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const stubRunDir = join(repoRoot, "agent-runs", "smoke-operator-stub");
const OPERATOR_TIMEOUT_MS = 8_000;

async function collectOperatorSseEventTypes(baseUrl: string, timeoutMs: number): Promise<string[]> {
  const eventTypes: string[] = [];
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/operator/events`, { signal: controller.signal });
  if (!response.ok || !response.body) {
    throw new Error(`operator SSE endpoint returned ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const eventLine = frame.split("\n").find((line) => line.startsWith("event:"));
        if (!eventLine) {
          continue;
        }
        const eventType = eventLine.slice("event:".length).trim();
        eventTypes.push(eventType);
        if (eventType === "session_completed") {
          controller.abort();
          await reader.cancel().catch(() => undefined);
          return eventTypes;
        }
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      throw error;
    }
  } finally {
    clearTimeout(timeout);
  }

  controller.abort();
  await reader.cancel().catch(() => undefined);
  return eventTypes;
}

rmSync(stubRunDir, { recursive: true, force: true });

const summary = createStubAgentRun(repoRoot);
validateAgentRunSummary(summary);

assert.equal(existsSync(join(summary.run_dir, "transcript.md")), true);
assert.equal(existsSync(join(summary.run_dir, "summary.json")), true);

const transcript = readFileSync(join(summary.run_dir, "transcript.md"), "utf8");
assert.match(transcript, /## User Prompt/);
assert.match(transcript, /## Tool Activity/);
assert.match(transcript, /launch_evidence_job/);
assert.match(transcript, /## Final Answer/);
assert.match(transcript, /static-source evidence/i);

const parsedSummary = JSON.parse(readFileSync(join(summary.run_dir, "summary.json"), "utf8")) as AgentRunSummary;
validateAgentRunSummary(parsedSummary);
assert.deepEqual(parsedSummary.job_ids, ["job-stub-001"]);
assert.equal(parsedSummary.status, "succeeded");

const bashSummary = summarizeContactCli(
  { command: "npm run contact -- run mavlink-battery-status-bounds --target post --mode smoke" },
  { stdout: "Launched job-stub-cli-001\nstate: queued" },
);
assert.ok(bashSummary);
assert.equal(bashSummary?.operation, "run");
assert.equal(bashSummary?.job_id, "job-stub-cli-001");
assert.deepEqual(extractJobIdsFromText("watch job-stub-cli-001"), ["job-stub-cli-001"]);

process.env.CONTACT_OPERATOR_SMOKE_STUB = "1";
const { server, url } = await startDashboardServer({ port: 0 });
try {
  const sseEventsPromise = collectOperatorSseEventTypes(url, OPERATOR_TIMEOUT_MS);
  const promptResponse = await fetch(`${url}/api/operator/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Operator smoke stub", stub: true }),
  });
  assert.equal(promptResponse.status, 202);

  const deadline = Date.now() + OPERATOR_TIMEOUT_MS;
  let completed = false;
  while (Date.now() < deadline) {
    const stateResponse = await fetch(`${url}/api/operator/state`);
    const payload = (await stateResponse.json()) as { state: { phase: string; run_dir?: string } };
    if (payload.state.phase === "completed" && payload.state.run_dir) {
      assert.ok(existsSync(join(payload.state.run_dir, "transcript.md")));
      completed = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  assert.equal(completed, true, "operator stub session must reach completed state");

  const sseEvents = await sseEventsPromise;
  assert.ok(sseEvents.includes("session_started"), "operator SSE must emit session_started");
  assert.ok(sseEvents.includes("tool_started"), "operator SSE must emit tool_started");
  assert.ok(sseEvents.includes("contact_cli"), "operator SSE must emit contact_cli");
  assert.ok(sseEvents.includes("evidence_job_updated"), "operator SSE must emit evidence_job_updated");
  assert.ok(sseEvents.includes("session_completed"), "operator SSE must emit session_completed");
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

console.log("smoke:operator passed");
console.log(`- validated stub transcript at ${summary.run_dir}`);

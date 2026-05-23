import { strict as assert } from "node:assert";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createStubAgentRun,
  validateAgentRunSummary,
  type AgentRunSummary,
} from "../src/agent/transcript.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const stubRunDir = join(repoRoot, "agent-runs", "smoke-operator-stub");

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

console.log("smoke:operator passed");
console.log(`- validated stub transcript at ${summary.run_dir}`);

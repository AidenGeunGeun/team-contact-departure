import { runAgentOperator } from "../src/agent/run.js";

const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) {
  console.error('Usage: npm run agent -- "<user request>"');
  process.exitCode = 1;
} else {
  const { summary } = await runAgentOperator({ prompt });
  if (summary.status === "failed") {
    process.exitCode = 1;
  }
}

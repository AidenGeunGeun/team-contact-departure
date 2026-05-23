import {
  CANONICAL_DEMO_PROMPT,
  PARSER_FUZZ_DEMO_PROMPT,
  PX4_SITL_PROBE_DEMO_PROMPT,
} from "../src/agent/prompts.js";
import { runAgentOperator } from "../src/agent/run.js";

const demoMode = process.argv.includes("--px4-sitl-probe")
  ? "px4-sitl-probe"
  : process.argv.includes("--parser-fuzz")
    ? "parser-fuzz"
    : "static-source";
const prompt =
  demoMode === "px4-sitl-probe"
    ? PX4_SITL_PROBE_DEMO_PROMPT
    : demoMode === "parser-fuzz"
      ? PARSER_FUZZ_DEMO_PROMPT
      : CANONICAL_DEMO_PROMPT;

console.log("Contact Departure demo agent");
if (demoMode === "px4-sitl-probe") {
  console.log("This run evaluates the PX4 SITL runtime probe case and writes a local transcript.\n");
} else if (demoMode === "parser-fuzz") {
  console.log("This run evaluates the parser-library fuzz case and writes a local transcript.\n");
} else {
  console.log("This run evaluates the parser-bounds case at the post-patch alias and writes a local transcript.\n");
}

const { summary } = await runAgentOperator({
  prompt,
  runId: `demo-${demoMode}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
});

if (summary.status === "failed") {
  process.exitCode = 1;
} else {
  console.log("\nNext step: run `npm run dashboard` to inspect the evidence job artifacts this run created.");
}

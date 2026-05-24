import { createContactDepartureSession } from "../src/session.js";

const prompt = process.argv.slice(2).join(" ").trim() ||
  [
    "Run one Contact Departure evidence job end to end.",
    "Use `npm run contact -- show mavlink-battery-status-bounds` to read the case, then launch with `npm run contact -- run mavlink-battery-status-bounds --target post --mode smoke`.",
    "Watch the job until it reaches a terminal state, read artifacts under runs/, then summarize cautiously with the verdict, the resolved commit hash, the inspected file and function with line range, and the artifact paths. Make clear this is static-source evidence at a pinned PX4 commit, not SITL, fuzzing, or runtime MAVLink replay.",
  ].join(" ");

const { session, modelFallbackMessage } = await createContactDepartureSession({ persistSession: true });

try {
  if (modelFallbackMessage) {
    console.warn(modelFallbackMessage);
  }

  session.subscribe((event) => {
    if (event.type === "tool_execution_update") {
      console.log(`\n[tool update] ${event.toolName} ${JSON.stringify(event.partialResult.details)}`);
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  try {
    await session.prompt(prompt);
    console.log();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/api key|auth|login|unauthorized|forbidden/i.test(message)) {
      console.error("Model-backed smoke test needs pi auth for openai-codex. Run `npx pi`, then `/login openai-codex`, then retry.");
    } else {
      console.error(message);
    }
    process.exitCode = 1;
  }
} finally {
  session.dispose();
}

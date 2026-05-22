import { createContactDepartureSession } from "../src/session.js";

const prompt = process.argv.slice(2).join(" ").trim() ||
  "Verify the Contact Departure harness by calling ping with message baseline-ok, then summarize the result in one sentence.";

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
    if (message.includes("No API key found")) {
      console.error("Model-backed smoke test needs pi auth. Run `npx pi`, then `/login openai-codex`, then retry.");
    } else {
      console.error(message);
    }
    process.exitCode = 1;
  }
} finally {
  session.dispose();
}

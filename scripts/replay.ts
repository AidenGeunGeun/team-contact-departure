import { resolve } from "node:path";
import { loadBundleManifest, renderReplayReport, runBundleReplay } from "../src/replay/index.js";

async function main(): Promise<void> {
  const bundleArg = process.argv[2];
  if (!bundleArg) {
    console.error("Usage: npm run replay -- <bundle_path>");
    process.exit(1);
  }

  const bundlePath = resolve(bundleArg);
  await loadBundleManifest(bundlePath);
  const { manifest, outcome } = await runBundleReplay(bundlePath);
  const report = renderReplayReport(manifest, outcome);
  console.log(report);
  process.exit(outcome.pass ? 0 : 1);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  console.log("\nFAIL");
  process.exit(1);
});

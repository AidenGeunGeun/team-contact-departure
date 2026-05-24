import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { replayFakeSmoke } from "./fake-smoke.js";
import { replayMavlinkParserFuzz } from "./mavlink-parser-fuzz.js";
import { replayEvidencePair } from "./pair.js";
import { replayPx4RuntimeReplay } from "./px4-runtime-replay.js";
import { replayPx4SitlProbe } from "./px4-sitl-probe.js";
import { formatReplayReport } from "./report.js";
import { replayStaticSourceEvidence } from "./static-source-evidence.js";
import type { BundleManifest, ReplayOutcome } from "./types.js";

export async function loadBundleManifest(bundlePath: string): Promise<BundleManifest> {
  const manifestPath = join(bundlePath, "manifest.json");
  const raw = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw) as BundleManifest;
  if (manifest.schema_version !== 1) {
    throw new Error(`Unsupported bundle schema_version: ${manifest.schema_version}`);
  }
  return manifest;
}

export async function runBundleReplay(bundlePath: string): Promise<{ manifest: BundleManifest; outcome: ReplayOutcome }> {
  const resolvedBundle = resolve(bundlePath);
  const manifest = await loadBundleManifest(resolvedBundle);
  let outcome: ReplayOutcome;

  switch (manifest.runner_kind) {
    case "fake-smoke":
      outcome = await replayFakeSmoke(resolvedBundle, manifest);
      break;
    case "static-source-evidence":
      outcome = await replayStaticSourceEvidence(manifest);
      break;
    case "mavlink-parser-fuzz":
      outcome = await replayMavlinkParserFuzz(resolvedBundle, manifest);
      break;
    case "px4-sitl-probe":
      outcome = await replayPx4SitlProbe(resolvedBundle, manifest);
      break;
    case "px4-runtime-replay":
      outcome = await replayPx4RuntimeReplay(resolvedBundle, manifest);
      break;
    case "pair":
      outcome = await replayEvidencePair(resolvedBundle, manifest);
      break;
    default:
      throw new Error(`Unsupported runner_kind for replay: ${manifest.runner_kind}`);
  }

  return { manifest, outcome };
}

export function renderReplayReport(manifest: BundleManifest, outcome: ReplayOutcome): string {
  return formatReplayReport(manifest, outcome);
}

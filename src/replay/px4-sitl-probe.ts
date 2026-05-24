import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  comparePreflightReports,
  loadPx4SitlProbeConfig,
  runPx4SitlPreflight,
  type PreflightReport,
} from "../domain/px4-sitl-probe.js";
import { buildPartialReplayOutcome } from "./report.js";
import type { BundleManifest, ReplayOutcome } from "./types.js";

const REQUIRED_ARTIFACTS = ["preflight-report.json", "evidence-summary.md", "runner.log"];

function formatPreflightComparison(comparison: ReturnType<typeof comparePreflightReports>): string[] {
  const lines = [
    "Preflight comparison (recorded bundle vs current environment):",
    "",
    "Still hold:",
  ];
  if (comparison.still_hold.length === 0) {
    lines.push("  (none)");
  } else {
    for (const item of comparison.still_hold) {
      lines.push(`  - ${item}`);
    }
  }
  lines.push("", "Differ:");
  if (comparison.differ.length === 0) {
    lines.push("  (none)");
  } else {
    for (const item of comparison.differ) {
      lines.push(
        `  - ${item.name}: recorded=${item.recorded ? "available" : "unavailable"}, current=${item.current ? "available" : "unavailable"}`,
      );
    }
  }
  lines.push(
    "",
    `PX4 binary present: recorded=${comparison.recorded_px4_binary_present}, current=${comparison.current_px4_binary_present}`,
    `All required tools: recorded=${comparison.recorded_all_required_available}, current=${comparison.current_all_required_available}`,
  );
  return lines;
}

export async function replayPx4SitlProbe(bundleDir: string, manifest: BundleManifest): Promise<ReplayOutcome> {
  for (const name of REQUIRED_ARTIFACTS) {
    const path = join(bundleDir, "artifacts", name);
    if (!existsSync(path)) {
      throw new Error(`Missing required artifact: artifacts/${name}`);
    }
    if (name.endsWith(".json")) {
      JSON.parse(await readFile(path, "utf8"));
    }
  }

  const recordedPreflight = JSON.parse(
    await readFile(join(bundleDir, "artifacts", "preflight-report.json"), "utf8"),
  ) as PreflightReport;

  const config = await loadPx4SitlProbeConfig();
  const currentPreflight = await runPx4SitlPreflight(config);
  const comparison = comparePreflightReports(recordedPreflight, currentPreflight);

  const artifactsOk = true;
  const preflightComparable = true;
  const pass = artifactsOk && preflightComparable;

  return buildPartialReplayOutcome({
    lines: [
      "Partial replay: verified recorded artifacts are structurally present.",
      "Preflight re-evaluated against current environment.",
      ...formatPreflightComparison(comparison),
      "",
      "Runtime re-boot is not part of partial replay.",
    ],
    pass,
    recorded_verdict: manifest.recorded_result.verdict,
    integrity_note: pass
      ? "artifacts present; preflight re-evaluation completed"
      : "artifact or preflight integrity check failed",
  });
}

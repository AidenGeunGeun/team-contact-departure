import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadPx4RuntimeReplayConfig,
  producePx4RuntimeReplayEvidence,
} from "../domain/px4-runtime-replay.js";
import { buildFullReplayOutcome, buildPartialReplayOutcome } from "./report.js";
import type { BundleManifest, ReplayOutcome } from "./types.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REQUIRED_ARTIFACTS = ["frame-record.json", "evidence-summary.md"];

async function verifyArtifacts(bundleDir: string): Promise<void> {
  for (const name of REQUIRED_ARTIFACTS) {
    const path = join(bundleDir, "artifacts", name);
    if (!existsSync(path)) {
      throw new Error(`Missing required artifact: artifacts/${name}`);
    }
    if (name.endsWith(".json")) {
      JSON.parse(await readFile(path, "utf8"));
    }
  }
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function replayPx4RuntimeReplay(bundleDir: string, manifest: BundleManifest): Promise<ReplayOutcome> {
  await verifyArtifacts(bundleDir);

  const frameRecord = JSON.parse(
    await readFile(join(bundleDir, "artifacts", "frame-record.json"), "utf8"),
  ) as { frame_hex?: string };
  const frameHex = frameRecord.frame_hex?.trim().toLowerCase();
  if (!frameHex) {
    throw new Error("frame-record.json is missing frame_hex.");
  }
  const frameHash = sha256Hex(Buffer.from(frameHex, "hex"));
  const pinnedHash = String(manifest.pinned_inputs.frame_bytes_hash ?? "");
  if (pinnedHash && pinnedHash !== frameHash) {
    throw new Error(`Frame bytes hash mismatch (expected ${pinnedHash}, got ${frameHash}).`);
  }

  const config = await loadPx4RuntimeReplayConfig();
  const resolvedHash = String(manifest.pinned_inputs.px4_commit_hash ?? "").toLowerCase();
  const buildManifestPath = join(
    REPO_ROOT,
    config.px4_cache_dir,
    config.build_manifest_filename ?? ".contact-departure-sitl-build.json",
  );
  const sitlBinaryPath = join(REPO_ROOT, config.px4_cache_dir, config.sitl_binary_relative);

  let buildManifestCommit: string | undefined;
  if (existsSync(buildManifestPath)) {
    const buildManifest = JSON.parse(await readFile(buildManifestPath, "utf8")) as { commit_hash?: string };
    buildManifestCommit = buildManifest.commit_hash?.toLowerCase();
  }

  const canFullReplay =
    Boolean(resolvedHash) &&
    Boolean(buildManifestCommit) &&
    buildManifestCommit === resolvedHash &&
    existsSync(sitlBinaryPath);

  if (canFullReplay) {
    const outcome = await producePx4RuntimeReplayEvidence({
      case_id: manifest.case_id,
      test_card_id: manifest.test_card_id,
      target_commit: manifest.target_commit,
      budget_profile: manifest.budget_profile,
      artifact_dir: join(bundleDir, ".replay-tmp"),
    });
    const rederivedOutcome =
      outcome.kind === "evidence" ? outcome.evidence.outcome ?? "runtime_unavailable" : "runtime_unavailable";
    const recordedOutcome = manifest.recorded_result.outcome ?? manifest.recorded_result.verdict;
    const pass = rederivedOutcome === recordedOutcome;
    const rederivedVerdict =
      rederivedOutcome === "runtime_anomalous"
        ? "attention_required"
        : rederivedOutcome === "runtime_clean"
          ? "manual_review_needed"
          : "manual_review_needed";

    return buildFullReplayOutcome({
      lines: [
        "Full replay path: verified PX4 build manifest matches recorded commit; re-delivered frame.",
        `Observed outcome: ${rederivedOutcome}`,
      ],
      pass,
      rederived_verdict: rederivedVerdict,
      recorded_verdict: manifest.recorded_result.verdict,
    });
  }

  const frameHashOk = !pinnedHash || pinnedHash === frameHash;
  const pass = frameHashOk;

  return buildPartialReplayOutcome({
    lines: [
      "Partial replay: verified frame bytes hash and recorded artifact structure.",
      frameHashOk
        ? `Frame bytes hash matches pinned hash (${pinnedHash}).`
        : `Frame bytes hash mismatch (pinned ${pinnedHash}, got ${frameHash}).`,
      "Runtime re-delivery requires verified PX4 build at recorded commit.",
      `Recorded commit: ${manifest.pinned_inputs.px4_commit_hash ?? "unknown"}`,
    ],
    pass,
    recorded_verdict: manifest.recorded_result.verdict,
    integrity_note: pass
      ? "artifacts present; frame hash verified against pinned inputs"
      : "frame hash or artifact integrity check failed",
  });
}

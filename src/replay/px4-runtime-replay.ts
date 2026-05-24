import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadPx4RuntimeReplayConfig,
  normalizeSanitizersList,
  producePx4RuntimeReplayEvidence,
  readLocalBuildManifest,
  readLocalBuildSanitizers,
  sanitizersListsEqual,
  type SitlBuildMethod,
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

function pinnedBuildMethod(manifest: BundleManifest): SitlBuildMethod | undefined {
  const value = manifest.pinned_inputs.build_method;
  return typeof value === "string" && value.length > 0 ? (value as SitlBuildMethod) : undefined;
}

export async function replayPx4RuntimeReplay(bundleDir: string, manifest: BundleManifest): Promise<ReplayOutcome> {
  const config = await loadPx4RuntimeReplayConfig();
  const pinnedSanitizers = normalizeSanitizersList(
    Array.isArray(manifest.pinned_inputs.sanitizers_used)
      ? (manifest.pinned_inputs.sanitizers_used as string[])
      : undefined,
  );
  const localSanitizers = await readLocalBuildSanitizers(config);
  if (!sanitizersListsEqual(pinnedSanitizers, localSanitizers)) {
    throw new Error(
      `Replay refused: sanitizer configuration mismatch (pinned [${pinnedSanitizers.join(", ") || "none"}] vs local [${localSanitizers.join(", ") || "none"}]).`,
    );
  }

  const expectedBuildMethod = pinnedBuildMethod(manifest);
  const localManifest = await readLocalBuildManifest(config);
  const localBuildMethod = localManifest?.build_method;
  if (expectedBuildMethod && localBuildMethod !== expectedBuildMethod) {
    throw new Error(
      `Replay refused: build method mismatch (pinned ${expectedBuildMethod} vs local ${localBuildMethod ?? "none"}).`,
    );
  }

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

  const resolvedHash = String(manifest.pinned_inputs.px4_commit_hash ?? "").toLowerCase();
  const buildManifestPath = join(
    REPO_ROOT,
    config.px4_cache_dir,
    config.build_manifest_filename ?? ".contact-departure-sitl-build.json",
  );

  let buildManifestCommit: string | undefined;
  let verifiedBinaryPath: string | undefined;
  if (existsSync(buildManifestPath) && localManifest) {
    buildManifestCommit = localManifest.commit_hash?.toLowerCase();
    if (
      buildManifestCommit === resolvedHash &&
      sanitizersListsEqual(localManifest.sanitizers_enabled, pinnedSanitizers) &&
      (!expectedBuildMethod || localManifest.build_method === expectedBuildMethod)
    ) {
      verifiedBinaryPath = localManifest.binary_path;
    } else {
      buildManifestCommit = undefined;
    }
  }

  const canFullReplay =
    Boolean(resolvedHash) &&
    Boolean(buildManifestCommit) &&
    buildManifestCommit === resolvedHash &&
    typeof verifiedBinaryPath === "string" &&
    existsSync(verifiedBinaryPath) &&
    sanitizersListsEqual(pinnedSanitizers, localSanitizers);

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

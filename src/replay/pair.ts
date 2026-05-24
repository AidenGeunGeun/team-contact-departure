import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { recomputeEvidencePairFromJobs } from "../domain/evidence-pair.js";
import { buildFullReplayOutcome } from "./report.js";
import type { BundleManifest, ReplayOutcome } from "./types.js";

interface FrameRecordFile {
  frame_hex?: string;
}

async function readEmbeddedFrameHex(jobDir: string): Promise<string> {
  const framePath = join(jobDir, "artifacts", "frame-record.json");
  const record = JSON.parse(await readFile(framePath, "utf8")) as FrameRecordFile;
  const frameHex = record.frame_hex?.trim().toLowerCase();
  if (!frameHex) {
    throw new Error(`Missing frame_hex in ${framePath}`);
  }
  return frameHex;
}

export async function replayEvidencePair(bundleDir: string, manifest: BundleManifest): Promise<ReplayOutcome> {
  const pairPath = join(bundleDir, "pair.json");
  const recordedPairRaw = await readFile(pairPath, "utf8");
  const recordedPair = JSON.parse(recordedPairRaw);

  const preJobDir = join(bundleDir, "artifacts", "jobs", "pre-patch");
  const postJobDir = join(bundleDir, "artifacts", "jobs", "post-patch");
  const preResultPath = join(preJobDir, "result.json");
  const postResultPath = join(postJobDir, "result.json");
  const preJobPath = join(preJobDir, "job.json");
  const postJobPath = join(postJobDir, "job.json");

  const preFrameHex = await readEmbeddedFrameHex(preJobDir);
  const postFrameHex = await readEmbeddedFrameHex(postJobDir);
  const framesEqual = preFrameHex === postFrameHex;

  const recomputed = await recomputeEvidencePairFromJobs({
    preJob: JSON.parse(await readFile(preJobPath, "utf8")),
    preResult: JSON.parse(await readFile(preResultPath, "utf8")),
    postJob: JSON.parse(await readFile(postJobPath, "utf8")),
    postResult: JSON.parse(await readFile(postResultPath, "utf8")),
    pairId: manifest.pair_id ?? recordedPair.pair_id,
    comparedAt: recordedPair.compared_at,
  });

  const recomputedRaw = `${JSON.stringify(recomputed, null, 2)}\n`;
  const pairRecordValid = recomputedRaw === recordedPairRaw;
  const pass = pairRecordValid && framesEqual;
  const rederivedVerdict = pass ? "pair_record_valid" : "pair_record_invalid";
  const recordedVerdict = manifest.recorded_result.verdict;

  return buildFullReplayOutcome({
    lines: [
      "Pair replay: re-ran pair computation on embedded job results.",
      pairRecordValid
        ? "pair.json byte-equal to recomputed record."
        : "pair.json differs from recomputed record.",
      framesEqual
        ? "Embedded frame-record.json bytes match across pre-patch and post-patch jobs."
        : "Embedded frame-record.json bytes differ between pre-patch and post-patch jobs.",
    ],
    pass: pass && rederivedVerdict === recordedVerdict,
    rederived_verdict: rederivedVerdict,
    recorded_verdict: recordedVerdict,
  });
}

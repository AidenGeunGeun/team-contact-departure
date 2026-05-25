import { runRemotePx4RuntimeReplayBridge } from "../domain/jobs.js";

const jobId = process.argv[2];

if (!jobId) {
  process.stderr.write("Usage: remote-px4-runtime-bridge <job_id>\n");
  process.exit(2);
}

await runRemotePx4RuntimeReplayBridge(jobId);

import { runStandalonePx4RuntimeReplayJob } from "../domain/jobs.js";

const jobId = process.argv[2];

if (!jobId) {
  process.stderr.write("Usage: px4-runtime-replay-runner <job_id>\n");
  process.exit(2);
}

await runStandalonePx4RuntimeReplayJob(jobId);

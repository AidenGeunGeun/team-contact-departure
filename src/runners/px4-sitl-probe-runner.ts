import { runStandalonePx4SitlProbeJob } from "../domain/jobs.js";

const jobId = process.argv[2];

if (!jobId) {
  process.stderr.write("Usage: px4-sitl-probe-runner <job_id>\n");
  process.exit(2);
}

await runStandalonePx4SitlProbeJob(jobId);

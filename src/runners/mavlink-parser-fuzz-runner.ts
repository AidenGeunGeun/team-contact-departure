import { runStandaloneMavlinkParserFuzzJob } from "../domain/jobs.js";

const jobId = process.argv[2];

if (!jobId) {
  process.stderr.write("Usage: mavlink-parser-fuzz-runner <job_id>\n");
  process.exit(2);
}

await runStandaloneMavlinkParserFuzzJob(jobId);

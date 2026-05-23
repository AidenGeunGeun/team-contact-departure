import { runStandaloneStaticSourceEvidenceJob } from "../domain/jobs.js";

const jobId = process.argv[2];

if (!jobId) {
  process.stderr.write("Usage: static-source-evidence-runner <job_id>\n");
  process.exit(2);
}

await runStandaloneStaticSourceEvidenceJob(jobId);

export const CANONICAL_DEMO_PROMPT = [
  "Evaluate the MAVLink battery status parser-bounds case for Contact Departure.",
  "Use `npm run contact -- cases` and `npm run contact -- show mavlink-battery-status-bounds` to read the case.",
  "Launch an evidence job with `npm run contact -- run mavlink-battery-status-bounds --target post --mode smoke`.",
  "Watch the job with `npm run contact -- watch <job_id>` until it reaches a terminal state, reporting the job id and concise progress updates along the way.",
  "Read the job artifacts under runs/ and summarize the final result with the verdict, runner kind, artifact paths, resolved commit hash, inspected file and function with line range, PR URL when available, caveats, and a recommended next evidence step.",
  "Write a brief analyst judgment under agent-judgments/. Speak cautiously in terms of evidence gathered in this run. Make clear this is static-source evidence at a pinned PX4 commit, not SITL, fuzzing, or runtime MAVLink replay, and do not claim firmware is safe or unsafe.",
].join(" ");

export const PX4_SITL_PROBE_DEMO_PROMPT = [
  "Evaluate the PX4 SITL runtime probe case for Contact Departure.",
  "Use `npm run contact -- show px4-runtime-probe` to read the case and recommended commands.",
  "Launch an evidence job with `npm run contact -- run px4-runtime-probe --target demo --mode smoke`.",
  "Watch the job with `npm run contact -- watch <job_id>` until it reaches a terminal state, reporting the returned job id and concise progress updates along the way.",
  "Read artifacts and summarize the final result with the verdict, runner kind, runtime outcome, heartbeat observation if any, artifact paths, runtime-probe caveats, and a recommended next evidence step.",
  "Write a brief analyst judgment under agent-judgments/. Make clear this is PX4 runtime probe evidence only, not proof of firmware safety or parser-bounds vulnerability replay.",
].join(" ");

export const PARSER_FUZZ_DEMO_PROMPT = [
  "Evaluate the MAVLink parser library fuzz case for Contact Departure.",
  "Use `npm run contact -- show mavlink-parser-library-fuzz` to read the case and recommended commands.",
  "Launch an evidence job with `npm run contact -- run mavlink-parser-library-fuzz --target demo --mode smoke`.",
  "Watch the job with `npm run contact -- watch <job_id>` until it reaches a terminal state, reporting the returned job id and concise progress updates along the way.",
  "Read artifacts and summarize the final result with the verdict, runner kind, mutation budget, pymavlink version, message family, inputs tried, exceptions found if any, artifact paths, parser-library-only caveats, and a recommended next evidence step.",
  "Write a brief analyst judgment under agent-judgments/. Make clear this is parser-library evidence using pymavlink, not PX4 SITL or firmware runtime proof, and do not claim firmware is safe or unsafe.",
].join(" ");

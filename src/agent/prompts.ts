export const CANONICAL_DEMO_PROMPT = [
  "Evaluate the MAVLink battery status parser-bounds case for Contact Departure.",
  "State which case you are evaluating, load it before choosing a methodology card, list the test cards, and select the parser-bounds card with a brief explanation of why it fits.",
  "Launch an evidence job using target_commit mavlink-battery-status-bounds-post.",
  "Inspect the job until it reaches a terminal state, reporting the returned job id and concise progress updates along the way.",
  "Summarize the final result with the verdict, runner kind, artifact paths, resolved commit hash, inspected file and function with line range, PR URL when available, caveats, and a recommended next evidence step.",
  "Speak cautiously in terms of evidence gathered in this run. Make clear this is static-source evidence at a pinned PX4 commit, not SITL, fuzzing, or runtime MAVLink replay, and do not claim firmware is safe or unsafe.",
].join(" ");

export const PX4_SITL_PROBE_DEMO_PROMPT = [
  "Evaluate the PX4 SITL runtime probe case for Contact Departure.",
  "State which case you are evaluating, load it before choosing a methodology card, list the test cards, and select the px4-sitl-probe card with a brief explanation of why it fits.",
  "Launch an evidence job using target_commit px4-sitl-probe-demo and budget_profile smoke-fast.",
  "Inspect the job until it reaches a terminal state, reporting the returned job id and concise progress updates along the way.",
  "Summarize the final result with the verdict, runner kind, runtime outcome, heartbeat observation if any, artifact paths, runtime-probe caveats, and a recommended next evidence step (for example handler-specific harness or bounded runtime fuzz once stable).",
  "Make clear this is PX4 runtime probe evidence only, not proof of firmware safety or parser-bounds vulnerability replay.",
].join(" ");

export const PARSER_FUZZ_DEMO_PROMPT = [
  "Evaluate the MAVLink parser library fuzz case for Contact Departure.",
  "State which case you are evaluating, load it before choosing a methodology card, list the test cards, and select the mavlink-parser-fuzz card with a brief explanation of why it fits.",
  "Launch an evidence job using target_commit parser-fuzz-demo and budget_profile smoke-fast.",
  "Inspect the job until it reaches a terminal state, reporting the returned job id and concise progress updates along the way.",
  "Summarize the final result with the verdict, runner kind, mutation budget, pymavlink version, message family, inputs tried, exceptions found if any, artifact paths, parser-library-only caveats, and a recommended next evidence step (for example PX4 SITL or handler-specific harness).",
  "Make clear this is parser-library evidence using pymavlink, not PX4 SITL or firmware runtime proof, and do not claim firmware is safe or unsafe.",
].join(" ");

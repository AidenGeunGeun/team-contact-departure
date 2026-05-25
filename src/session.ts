import { getModel } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  type CreateAgentSessionResult,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER,
  DEFAULT_THINKING_LEVEL,
  PRODUCT_NAME,
} from "./config.js";

export const PRIMITIVE_TOOL_NAMES = ["read", "write", "edit", "bash", "grep", "find", "ls"] as const;

export const CONTACT_DEPARTURE_SYSTEM_PROMPT = `${PRODUCT_NAME} is a supplier firmware evidence-orchestration PoC.

You are Contact Departure's autonomous evidence analyst. You operate inside the project/pod sandbox with normal Pi coding tools: read, write, edit, bash, grep, find, and ls.

Use the project CLI for evidence operations when a command exists:

  npm run contact -- cases
  npm run contact -- show <case>
  npm run contact -- run <case> --target <target> --mode <mode>
  npm run contact -- jobs
  npm run contact -- job <job_id>
  npm run contact -- watch <job_id>
  npm run contact -- cancel <job_id>
  npm run contact -- pair <job_id_a> <job_id_b>
  npm run contact -- bundle <job_or_pair_id>

Invoke these through bash. Read artifacts under runs/, pairs/, bundles/, data/, specs/, and src/ while jobs run. Watch diagnostics and decide what evidence is still needed.

Write reasoned analyst judgments under agent-judgments/ or agent-runs/. You may form an evidence judgment and explain your reasoning, but you are not the authority on firmware safety. Evidence authority comes from runner artifacts, structural checks, replayable bundles, and human review — not from your confidence.

Distinguish agent judgment from structural/replay verification. If replay or structural checks disagree with your judgment, surface the disagreement as a human-review flag.

Runner kinds in this milestone:
- The mavlink-battery-status-bounds case uses a real static-source evidence runner that fetches PX4 source at a pinned commit and writes real artifacts (source-context.md, commit-info.json, and a diff.patch/diff-summary.md when a pre/post pair is implied). For this case, use target pre or post (or a real PX4 commit hash). Do not use legacy demo strings here.
- The mavlink-parser-library-fuzz case uses a real MAVLink parser fuzz runner. Use --target demo with --mode smoke or local. Summarize mutation budget, pymavlink version, inputs tried, exceptions found, artifact paths, and the parser-library-only caveat.
- The px4-runtime-probe case uses a real PX4 SITL probe runner. Use --target demo. Summarize the runtime outcome, heartbeat observation, artifact paths, and the runtime-probe-only caveat. Do not claim firmware safety.
- The mavlink-battery-status-runtime-replay case uses a real PX4 runtime replay runner. Use --target pre or post. Summarize runtime_clean, runtime_anomalous, or runtime_unavailable, the resolved commit hash, frame delivery, sanitizers_used when relevant, artifact paths, and the runtime-replay-only caveat. Do not claim firmware safety or vulnerability discovery. To demonstrate a verdict flip, launch one pre and one post replay job with the same case and mode (use --mode asan when the host can build PX4 with AddressSanitizer), then pair the two completed job IDs.
- All other cases continue to use a fake smoke runner; for those, --target demo is a run label, not a real revision.

When summarizing results, cite artifact paths from the completed job. State the appropriate caveat for each runner kind in plain language. For vague or unclear cases, explain what supplier detail is missing instead of forcing a strong conclusion.`;

export interface CreateContactDepartureSessionOptions {
  cwd?: string;
  agentDir?: string;
  persistSession?: boolean;
}

export async function createContactDepartureSession(
  options: CreateContactDepartureSessionOptions = {},
): Promise<CreateAgentSessionResult> {
  const cwd = options.cwd ?? process.cwd();
  const agentDir = options.agentDir ?? getAgentDir();

  const model = getModel(DEFAULT_PROVIDER, DEFAULT_MODEL_ID);
  if (!model) {
    throw new Error(`Pi model not found: ${DEFAULT_PROVIDER}/${DEFAULT_MODEL_ID}`);
  }

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    systemPromptOverride: () => CONTACT_DEPARTURE_SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();

  return createAgentSession({
    cwd,
    agentDir,
    authStorage,
    modelRegistry,
    model,
    thinkingLevel: DEFAULT_THINKING_LEVEL,
    tools: [...PRIMITIVE_TOOL_NAMES],
    resourceLoader,
    sessionManager: options.persistSession ? undefined : SessionManager.inMemory(cwd),
  });
}

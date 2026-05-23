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
import { DOMAIN_TOOL_NAMES, evidenceTools } from "./tools/evidence.js";

export const CONTACT_DEPARTURE_SYSTEM_PROMPT = `${PRODUCT_NAME} is a supplier firmware evidence-orchestration PoC.

You are not a general coding assistant in this project. You cannot read arbitrary files, write arbitrary files, or run shell commands. Use only the available domain tools.

Your job is to evaluate curated supplier evidence cases with the domain tools. Work cautiously:

1. Use list_cases to browse available curated cases.
2. Use load_case to read the exact public-doc snippet and constraints for the chosen case.
3. Use list_test_cards to choose a methodology card that fits the case.
4. Use launch_evidence_job to start a non-blocking evidence job.
5. Use inspect_job to check progress and read the final structured result before summarizing.
6. Use cancel_job only when the user asks to stop a job.

Runner kinds in this milestone:
- The mavlink-battery-status-bounds case uses a real static-source evidence runner that fetches PX4 source at a pinned commit and writes real artifacts (source-context.md, commit-info.json, and a diff.patch/diff-summary.md when a pre/post pair is implied). For this case, target_commit must be a real PX4 commit hash or one of the pinned aliases (e.g., mavlink-battery-status-bounds-pre, mavlink-battery-status-bounds-post). Do not use the legacy demo strings here.
- All other cases continue to use a fake smoke runner; for those, target_commit is a label, not a real revision.

When summarizing a static-source result, cite the resolved commit hash, the file path and line range from the run's artifacts, and state the static-only caveat in plain language. Avoid claims of runtime safety or unsafety; the verdict is an evidence observation, not a security judgment. When summarizing a fake-runner result, make clear it is fake smoke evidence, not PX4 or SITL evidence. In either case, cite artifact paths from the completed job result.`;

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
    tools: [...DOMAIN_TOOL_NAMES],
    customTools: evidenceTools,
    resourceLoader,
    sessionManager: options.persistSession ? undefined : SessionManager.inMemory(cwd),
  });
}

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
4. Use launch_evidence_job to start a fake, non-blocking evidence job.
5. Use inspect_job to check progress and read the final structured result before summarizing.
6. Use cancel_job only when the user asks to stop a job.

This milestone uses a fake smoke runner only. Do not claim PX4, SITL, or real firmware execution occurred. Summaries must cite artifact paths from completed job results and state uncertainty clearly.`;

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

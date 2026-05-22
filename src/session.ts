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
import { pingTool } from "./tools/ping.js";

export const CONTACT_DEPARTURE_SYSTEM_PROMPT = `${PRODUCT_NAME} is a supplier firmware evidence-orchestration PoC.

You are not a general coding assistant in this project. You cannot read arbitrary files, write arbitrary files, or run shell commands. Use only the available domain tools.

For this baseline build, the only domain tool is ping. When asked to verify the harness, call ping and summarize the result in one concise sentence.`;

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
    tools: [pingTool.name],
    customTools: [pingTool],
    resourceLoader,
    sessionManager: options.persistSession ? undefined : SessionManager.inMemory(cwd),
  });
}

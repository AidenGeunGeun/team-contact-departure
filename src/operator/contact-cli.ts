import type { ContactCliOperation, ContactCliSummary } from "./types.js";

const JOB_ID_PATTERN = /job-[A-Za-z0-9_-]+/g;

export function asCommand(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  if (value && typeof value === "object" && "command" in value) {
    const command = (value as { command?: unknown }).command;
    return typeof command === "string" ? command : undefined;
  }
  return undefined;
}

function asText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    if ("details" in value) {
      const nested = asText((value as { details?: unknown }).details);
      if (nested) {
        return nested;
      }
    }
    if ("stdout" in value && typeof (value as { stdout?: unknown }).stdout === "string") {
      const stdout = (value as { stdout: string }).stdout;
      const stderr =
        "stderr" in value && typeof (value as { stderr?: unknown }).stderr === "string"
          ? (value as { stderr: string }).stderr
          : "";
      return [stdout, stderr].filter(Boolean).join("\n");
    }
    if ("output" in value && typeof (value as { output?: unknown }).output === "string") {
      return (value as { output: string }).output;
    }
    if ("stderr" in value && typeof (value as { stderr?: unknown }).stderr === "string") {
      return (value as { stderr: string }).stderr;
    }
    if ("error" in value && typeof (value as { error?: unknown }).error === "string") {
      return (value as { error: string }).error;
    }
  }
  return undefined;
}

export function extractJobIdsFromText(text: string | undefined): string[] {
  if (!text) {
    return [];
  }
  return [...new Set(text.match(JOB_ID_PATTERN) ?? [])];
}

function contactTail(command: string): string[] {
  const normalized = command.replace(/\s+/g, " ").trim();
  const marker = normalized.match(/(?:npm run )?contact\s+--\s+(.*)$/i);
  if (marker?.[1]) {
    return marker[1].split(/\s+/).filter(Boolean);
  }
  return [];
}

function operationTitle(operation: ContactCliOperation, tail: string[]): string {
  switch (operation) {
    case "cases":
      return "List evidence cases";
    case "jobs":
      return "List evidence jobs";
    case "show":
      return `Show case ${tail[1] ?? "details"}`;
    case "run":
      return `Launch evidence job for ${tail[1] ?? "case"}`;
    case "watch":
      return `Watch job ${tail[1] ?? ""}`.trim();
    case "job":
      return `Inspect job ${tail[1] ?? ""}`.trim();
    case "cancel":
      return `Cancel job ${tail[1] ?? ""}`.trim();
    case "pair":
      return `Compare jobs ${tail[1] ?? ""} and ${tail[2] ?? ""}`.trim();
    case "bundle":
      return `Create bundle from ${tail[1] ?? "record"}`;
    case "replay":
      return `Replay bundle ${tail[0] ?? ""}`.trim();
    default:
      return "Contact CLI command";
  }
}

export function summarizeContactCli(args: unknown, result?: unknown): ContactCliSummary | undefined {
  const command = asCommand(args);
  if (!command) {
    return undefined;
  }

  const replayMatch = command.match(/(?:npm run )?replay\s+--\s+(\S+)/i);
  if (replayMatch) {
    const bundlePath = replayMatch[1];
    const resultText = asText(result);
    return {
      operation: "replay",
      title: `Replay bundle ${bundlePath}`,
      detail: resultText?.split("\n").slice(0, 2).join(" ").trim().slice(0, 180),
    };
  }

  if (!/(?:npm run )?contact\s+--/i.test(command)) {
    return undefined;
  }

  const tail = contactTail(command);
  const operation = (tail[0] as ContactCliOperation | undefined) ?? "unknown";
  const resultText = asText(result);
  const jobIds = extractJobIdsFromText(`${command}\n${resultText ?? ""}`);
  const jobId =
    operation === "watch" || operation === "job" || operation === "cancel" ? tail[1] ?? jobIds[0] : jobIds[0];

  let detail: string | undefined;
  if (operation === "run" && jobId) {
    detail = `Job ${jobId} launched`;
  } else if (operation === "watch" && resultText) {
    const line = resultText.split("\n").find((entry) => /state|progress|phase/i.test(entry));
    detail = line?.trim() ?? resultText.split("\n").slice(-2).join(" ").trim();
  } else if (resultText) {
    detail = resultText.split("\n").slice(0, 2).join(" ").trim().slice(0, 180);
  }

  return {
    operation,
    title: operationTitle(operation, tail),
    detail,
    job_id: jobId,
    case_id: operation === "show" || operation === "run" ? tail[1] : undefined,
  };
}

export function summarizePrimitiveTool(toolName: string, args: unknown): string {
  if (toolName === "bash") {
    const command = asCommand(args);
    if (command) {
      return command.length > 120 ? `${command.slice(0, 117)}...` : command;
    }
  }
  if (toolName === "read" && args && typeof args === "object" && "path" in args) {
    return String((args as { path?: unknown }).path ?? "file");
  }
  if (toolName === "grep" && args && typeof args === "object" && "pattern" in args) {
    return `pattern ${String((args as { pattern?: unknown }).pattern ?? "")}`;
  }
  return toolName;
}

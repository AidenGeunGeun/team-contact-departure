import { asCommand, summarizeContactCli, summarizePrimitiveTool } from "./contact-cli.js";

export type ToolDisplayMode = "exploring" | "bash" | "generic";

export interface ToolDisplayPayload {
  display_mode: ToolDisplayMode;
  title: string;
  subtitle?: string;
  command?: string;
  explore_target?: string;
  output_preview?: string;
}

const EXPLORING_TOOLS = new Set(["read", "write", "edit", "grep", "find", "glob", "ls", "list"]);

function exploreTarget(toolName: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const record = args as Record<string, unknown>;
  if (typeof record.path === "string") {
    return record.path;
  }
  if (typeof record.pattern === "string") {
    return `pattern ${record.pattern}`;
  }
  if (typeof record.query === "string") {
    return record.query;
  }
  return summarizePrimitiveTool(toolName, args);
}

function outputPreview(result: unknown): string | undefined {
  if (typeof result === "string") {
    return result.trim().slice(0, 400);
  }
  if (result && typeof result === "object") {
    if ("details" in result) {
      const nested = outputPreview((result as { details?: unknown }).details);
      if (nested) {
        return nested;
      }
    }
    if ("stdout" in result && typeof (result as { stdout?: unknown }).stdout === "string") {
      const stdout = (result as { stdout: string }).stdout.trim();
      const stderr =
        "stderr" in result && typeof (result as { stderr?: unknown }).stderr === "string"
          ? (result as { stderr: string }).stderr.trim()
          : "";
      return [stdout, stderr].filter(Boolean).join("\n").slice(0, 400);
    }
    if ("output" in result && typeof (result as { output?: unknown }).output === "string") {
      return (result as { output: string }).output.trim().slice(0, 400);
    }
    if ("stderr" in result && typeof (result as { stderr?: unknown }).stderr === "string") {
      return (result as { stderr: string }).stderr.trim().slice(0, 400);
    }
    if ("error" in result && typeof (result as { error?: unknown }).error === "string") {
      return (result as { error: string }).error.trim().slice(0, 400);
    }
  }
  return undefined;
}

export function isExploringTool(toolName: string): boolean {
  return EXPLORING_TOOLS.has(toolName);
}

export function describeToolStart(toolName: string, args: unknown): ToolDisplayPayload {
  if (toolName === "bash") {
    const command = asCommand(args);
    return {
      display_mode: "bash",
      title: command ?? "bash",
      subtitle: command && command.length > 96 ? `${command.slice(0, 93)}…` : command,
      command,
    };
  }
  if (isExploringTool(toolName)) {
    return {
      display_mode: "exploring",
      title: "Exploring…",
      explore_target: exploreTarget(toolName, args),
    };
  }
  const title = summarizePrimitiveTool(toolName, args);
  return {
    display_mode: "generic",
    title,
    subtitle: title,
  };
}

export function describeToolEnd(
  toolName: string,
  args: unknown,
  result: unknown,
): ToolDisplayPayload {
  const start = describeToolStart(toolName, args);
  const preview = outputPreview(result);
  if (preview) {
    return { ...start, output_preview: preview };
  }
  return start;
}

export function isContactBash(args: unknown): boolean {
  return summarizeContactCli(args) !== undefined;
}

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { OperatorEvent } from "./types.js";

export interface OperatorSessionIndexEntry {
  session_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  phase: string;
  run_ids: string[];
  selected_job_id?: string;
}

function operatorRoot(cwd: string): string {
  return join(cwd, "agent-runs", ".operator");
}

function indexPath(cwd: string): string {
  return join(operatorRoot(cwd), "sessions.json");
}

function logPath(cwd: string, sessionId: string): string {
  return join(operatorRoot(cwd), "logs", `${sessionId}.jsonl`);
}

function ensureOperatorRoot(cwd: string): void {
  mkdirSync(join(operatorRoot(cwd), "logs"), { recursive: true });
}

function readIndex(cwd: string): OperatorSessionIndexEntry[] {
  ensureOperatorRoot(cwd);
  const path = indexPath(cwd);
  if (!existsSync(path)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { sessions?: OperatorSessionIndexEntry[] };
    return Array.isArray(parsed.sessions) ? parsed.sessions : [];
  } catch {
    return [];
  }
}

function writeIndex(cwd: string, sessions: OperatorSessionIndexEntry[]): void {
  ensureOperatorRoot(cwd);
  const sorted = [...sessions].sort(
    (left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at),
  );
  writeFileSync(indexPath(cwd), `${JSON.stringify({ sessions: sorted }, null, 2)}\n`, "utf8");
}

function sessionTitle(prompt: string): string {
  const trimmed = prompt.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return "Untitled session";
  }
  return trimmed.length > 72 ? `${trimmed.slice(0, 69)}…` : trimmed;
}

export function listOperatorSessions(cwd: string = process.cwd()): OperatorSessionIndexEntry[] {
  return readIndex(cwd);
}

export function upsertOperatorSession(
  cwd: string,
  patch: Partial<OperatorSessionIndexEntry> & { session_id: string },
): OperatorSessionIndexEntry {
  const sessions = readIndex(cwd);
  const existing = sessions.find((entry) => entry.session_id === patch.session_id);
  const now = new Date().toISOString();
  const next: OperatorSessionIndexEntry = {
    session_id: patch.session_id,
    title: patch.title ?? existing?.title ?? "Untitled session",
    created_at: existing?.created_at ?? patch.created_at ?? now,
    updated_at: patch.updated_at ?? now,
    phase: patch.phase ?? existing?.phase ?? "idle",
    run_ids: patch.run_ids ?? existing?.run_ids ?? [],
    selected_job_id: patch.selected_job_id ?? existing?.selected_job_id,
  };
  const without = sessions.filter((entry) => entry.session_id !== patch.session_id);
  writeIndex(cwd, [next, ...without]);
  return next;
}

export function registerOperatorSessionStart(
  cwd: string,
  sessionId: string,
  prompt: string,
  continuation: boolean,
): void {
  const sessions = readIndex(cwd);
  const existing = sessions.find((entry) => entry.session_id === sessionId);
  if (continuation && existing) {
    upsertOperatorSession(cwd, {
      session_id: sessionId,
      phase: "starting",
      updated_at: new Date().toISOString(),
    });
    return;
  }
  upsertOperatorSession(cwd, {
    session_id: sessionId,
    title: sessionTitle(prompt),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    phase: "starting",
    run_ids: [],
  });
}

export function appendOperatorSessionEvent(
  cwd: string,
  sessionId: string,
  event: OperatorEvent,
): void {
  if (!sessionId || sessionId === "none") {
    return;
  }
  ensureOperatorRoot(cwd);
  appendFileSync(logPath(cwd, sessionId), `${JSON.stringify(event)}\n`, "utf8");
}

export function readOperatorSessionEvents(
  cwd: string,
  sessionId: string,
): OperatorEvent[] {
  const path = logPath(cwd, sessionId);
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as OperatorEvent);
}

export function deleteOperatorSession(cwd: string, sessionId: string): boolean {
  const sessions = readIndex(cwd);
  const existing = sessions.find((entry) => entry.session_id === sessionId);
  if (!existing) {
    return false;
  }
  writeIndex(
    cwd,
    sessions.filter((entry) => entry.session_id !== sessionId),
  );
  const path = logPath(cwd, sessionId);
  if (existsSync(path)) {
    unlinkSync(path);
  }
  return true;
}

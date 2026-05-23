import { spawn } from "node:child_process";
import { readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CONFIG_PATH = join(REPO_ROOT, "data", "static-source-commits.json");
const CACHE_DIR = join(REPO_ROOT, ".cache", "px4");
const CACHE_LOCK_DIR = join(REPO_ROOT, ".cache", "px4.lock");
const CACHE_LOCK_TIMEOUT_MS = 120_000;
const CACHE_LOCK_POLL_MS = 50;
const GIT_NETWORK_TIMEOUT_MS = 90_000;
const GIT_LOCAL_TIMEOUT_MS = 15_000;

export type VerdictKind =
  | "static_evidence_consistent_with_claim"
  | "static_evidence_conflicts_with_claim"
  | "static_evidence_inconclusive"
  | "static_evidence_unavailable";

export interface StaticSourceConfigCase {
  pr_url: string;
  pr_title: string;
  target_file: string;
  target_function: string;
  pre_alias: string;
  post_alias: string;
  heuristic: string;
}

export interface StaticSourceConfigAlias {
  commit_hash: string;
  case_id: string;
  role: "pre-patch" | "post-patch";
  pair_alias: string;
  description: string;
}

export interface StaticSourceConfig {
  repository: { name: string; url: string };
  cases: Record<string, StaticSourceConfigCase>;
  aliases: Record<string, StaticSourceConfigAlias>;
}

export interface ResolvedTarget {
  target_commit: string;
  resolved_commit_hash: string;
  alias?: string;
  role?: "pre-patch" | "post-patch";
  pair?: {
    pre_hash: string;
    post_hash: string;
    pre_alias?: string;
    post_alias?: string;
  };
  case_config: StaticSourceConfigCase;
}

export interface CommitInfo {
  hash: string;
  parent_hashes: string[];
  subject: string;
  author_date: string;
  committer_date: string;
}

export interface SourceRegion {
  file_path: string;
  function_name: string;
  start_line: number;
  end_line: number;
  snippet: string;
}

export interface StaticSourceArtifacts {
  source_context_md: string;
  commit_info: {
    target_commit: string;
    resolved_commit_hash: string;
    parent_hashes: string[];
    subject: string;
    author_date: string;
    committer_date: string;
    repository_url: string;
    target_file: string;
    target_function: string;
  };
  diff_patch?: string;
  diff_summary_md?: string;
}

export interface StaticSourceEvidence {
  verdict_kind: VerdictKind;
  summary: string;
  caveats: string[];
  region?: SourceRegion;
  artifacts: StaticSourceArtifacts;
  resolved: ResolvedTarget;
  commit: CommitInfo;
  diff_files_changed?: string[];
}

export interface StaticSourceFailure {
  verdict_kind: "static_evidence_unavailable";
  summary: string;
  caveats: string[];
  failure_md: string;
  resolved_commit_hash?: string;
  target_commit: string;
  stage: string;
  detail: string;
}

export type StaticSourceOutcome =
  | { kind: "evidence"; evidence: StaticSourceEvidence }
  | { kind: "failure"; failure: StaticSourceFailure };

export class StaticSourceError extends Error {
  constructor(
    message: string,
    public readonly stage: string,
    public readonly detail: string,
  ) {
    super(message);
    this.name = "StaticSourceError";
  }
}

let cachedConfig: StaticSourceConfig | undefined;

export async function loadStaticSourceConfig(): Promise<StaticSourceConfig> {
  if (cachedConfig) {
    return cachedConfig;
  }
  const raw = await readFile(CONFIG_PATH, "utf8");
  cachedConfig = JSON.parse(raw) as StaticSourceConfig;
  return cachedConfig;
}

export function caseUsesStaticSource(caseId: string, config: StaticSourceConfig): boolean {
  return Object.prototype.hasOwnProperty.call(config.cases, caseId);
}

export function resolveTarget(
  caseId: string,
  targetCommit: string,
  config: StaticSourceConfig,
): ResolvedTarget {
  const caseConfig = config.cases[caseId];
  if (!caseConfig) {
    throw new StaticSourceError(
      `case_id ${caseId} is not configured for the static-source runner.`,
      "resolve-target",
      `No case entry in data/static-source-commits.json for ${caseId}.`,
    );
  }

  const trimmed = targetCommit.trim();
  const alias = config.aliases[trimmed];
  if (alias) {
    if (alias.case_id !== caseId) {
      throw new StaticSourceError(
        `target_commit alias ${trimmed} belongs to case ${alias.case_id}, not ${caseId}.`,
        "resolve-target",
        `Alias/case mismatch.`,
      );
    }
    const partner = config.aliases[alias.pair_alias];
    const pair = partner
      ? {
          pre_hash: alias.role === "pre-patch" ? alias.commit_hash : partner.commit_hash,
          post_hash: alias.role === "post-patch" ? alias.commit_hash : partner.commit_hash,
          pre_alias: alias.role === "pre-patch" ? trimmed : alias.pair_alias,
          post_alias: alias.role === "post-patch" ? trimmed : alias.pair_alias,
        }
      : undefined;
    return {
      target_commit: targetCommit,
      resolved_commit_hash: alias.commit_hash,
      alias: trimmed,
      role: alias.role,
      pair,
      case_config: caseConfig,
    };
  }

  if (!/^[0-9a-f]{7,40}$/i.test(trimmed)) {
    throw new StaticSourceError(
      `target_commit "${targetCommit}" is not a known alias and does not look like a git commit hash.`,
      "resolve-target",
      "Provide a known alias or a 7-40 character hex commit hash.",
    );
  }

  // Raw hash: try to infer pair if it matches a configured alias.
  const matchedAlias = Object.entries(config.aliases).find(([, value]) =>
    value.case_id === caseId && value.commit_hash.toLowerCase().startsWith(trimmed.toLowerCase()),
  );
  if (matchedAlias) {
    const [name, value] = matchedAlias;
    const partner = config.aliases[value.pair_alias];
    return {
      target_commit: targetCommit,
      resolved_commit_hash: value.commit_hash,
      alias: name,
      role: value.role,
      pair: partner
        ? {
            pre_hash: value.role === "pre-patch" ? value.commit_hash : partner.commit_hash,
            post_hash: value.role === "post-patch" ? value.commit_hash : partner.commit_hash,
            pre_alias: value.role === "pre-patch" ? name : value.pair_alias,
            post_alias: value.role === "post-patch" ? name : value.pair_alias,
          }
        : undefined,
      case_config: caseConfig,
    };
  }

  return {
    target_commit: targetCommit,
    resolved_commit_hash: trimmed.toLowerCase(),
    case_config: caseConfig,
  };
}

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runGit(
  args: string[],
  options: { cwd?: string; signal?: AbortSignal; timeoutMs?: number; allowFailure?: boolean } = {},
): Promise<GitResult> {
  const cwd = options.cwd ?? CACHE_DIR;
  const timeoutMs = options.timeoutMs ?? GIT_LOCAL_TIMEOUT_MS;
  return new Promise<GitResult>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      try {
        child.kill("SIGTERM");
      } catch {}
    };
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }
    const timer = setTimeout(() => {
      if (settled) return;
      try {
        child.kill("SIGTERM");
      } catch {}
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const code = exitCode ?? -1;
      if (code !== 0 && !options.allowFailure) {
        reject(
          new StaticSourceError(
            `git ${args.slice(0, 2).join(" ")} exited with code ${code}: ${stderr.trim() || stdout.trim()}`,
            "git",
            `args: ${JSON.stringify(args)}; stderr: ${stderr.trim()}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

async function lockOwnerIsAlive(): Promise<boolean> {
  try {
    const raw = await readFile(join(CACHE_LOCK_DIR, "owner.json"), "utf8");
    const owner = JSON.parse(raw) as { pid?: number };
    if (!owner.pid || !Number.isInteger(owner.pid)) {
      return false;
    }
    try {
      process.kill(owner.pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        return false;
      }
      // EPERM means the process exists but we can't signal it; treat as alive.
      return true;
    }
  } catch {
    return false;
  }
}

async function acquireCacheLock(signal?: AbortSignal): Promise<() => Promise<void>> {
  await mkdir(dirname(CACHE_LOCK_DIR), { recursive: true });
  const deadline = Date.now() + CACHE_LOCK_TIMEOUT_MS;
  while (true) {
    if (signal?.aborted) {
      throw new StaticSourceError(
        "Cache lock acquisition cancelled.",
        "cache-lock",
        "Runner cancelled before lock was acquired.",
      );
    }
    try {
      await mkdir(CACHE_LOCK_DIR);
      try {
        await writeFile(
          join(CACHE_LOCK_DIR, "owner.json"),
          JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }, null, 2),
          "utf8",
        );
      } catch (writeError) {
        await rm(CACHE_LOCK_DIR, { recursive: true, force: true });
        throw writeError;
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await rm(CACHE_LOCK_DIR, { recursive: true, force: true });
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }
      if (!(await lockOwnerIsAlive())) {
        await rm(CACHE_LOCK_DIR, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) {
        throw new StaticSourceError(
          `Timed out waiting for PX4 cache lock at ${CACHE_LOCK_DIR}.`,
          "cache-lock",
          "Another runner may be holding the cache lock; retry once the other run completes.",
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, CACHE_LOCK_POLL_MS));
    }
  }
}

async function ensureCacheRepo(repoUrl: string, signal?: AbortSignal): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  const gitDir = join(CACHE_DIR, ".git");
  const fullyInitialized = existsSync(gitDir) && existsSync(join(gitDir, "config"));
  if (!fullyInitialized) {
    // A previous runner may have died mid-init; wipe any partial state before re-initializing.
    if (existsSync(gitDir)) {
      await rm(gitDir, { recursive: true, force: true });
    }
    await runGit(["init", "-q"], { signal });
    await runGit(["remote", "add", "origin", repoUrl], { signal });
    return;
  }
  const remote = await runGit(["remote", "get-url", "origin"], { signal, allowFailure: true });
  if (remote.exitCode !== 0) {
    await runGit(["remote", "add", "origin", repoUrl], { signal });
  } else if (remote.stdout.trim() !== repoUrl) {
    await runGit(["remote", "set-url", "origin", repoUrl], { signal });
  }
}

async function hasCommitLocally(hash: string, signal?: AbortSignal): Promise<boolean> {
  const result = await runGit(["cat-file", "-e", `${hash}^{commit}`], {
    signal,
    allowFailure: true,
  });
  return result.exitCode === 0;
}

async function fetchCommit(hash: string, signal?: AbortSignal): Promise<void> {
  await runGit(
    ["fetch", "--filter=blob:none", "--depth", "1", "--no-tags", "origin", hash],
    { signal, timeoutMs: GIT_NETWORK_TIMEOUT_MS },
  );
}

async function ensureCommit(repoUrl: string, hash: string, signal?: AbortSignal): Promise<void> {
  await ensureCacheRepo(repoUrl, signal);
  if (await hasCommitLocally(hash, signal)) {
    return;
  }
  await fetchCommit(hash, signal);
  if (!(await hasCommitLocally(hash, signal))) {
    throw new StaticSourceError(
      `Fetched commit ${hash} but git cannot find it locally afterwards.`,
      "ensure-commit",
      "Unexpected post-fetch state.",
    );
  }
}

async function readFileAtCommit(hash: string, path: string, signal?: AbortSignal): Promise<string> {
  const result = await runGit(["show", `${hash}:${path}`], { signal });
  return result.stdout;
}

async function commitMetadata(hash: string, signal?: AbortSignal): Promise<CommitInfo> {
  const format = "%H%n%s%n%aI%n%cI";
  const showResult = await runGit(["show", "-s", `--format=${format}`, hash], { signal });
  const lines = showResult.stdout.trimEnd().split("\n");
  if (lines.length < 4) {
    throw new StaticSourceError(
      `git show returned unexpected metadata for ${hash}.`,
      "commit-metadata",
      showResult.stdout,
    );
  }
  // Read parent SHAs directly from the raw commit object so shallow fetches don't elide them.
  const rawResult = await runGit(["cat-file", "-p", `${hash}^{commit}`], { signal });
  const parents: string[] = [];
  for (const rawLine of rawResult.stdout.split("\n")) {
    if (rawLine.startsWith("parent ")) {
      parents.push(rawLine.slice("parent ".length).trim());
    } else if (rawLine.startsWith("author ") || rawLine.length === 0) {
      break;
    }
  }
  return {
    hash: lines[0].trim(),
    parent_hashes: parents,
    subject: lines[1],
    author_date: lines[2].trim(),
    committer_date: lines[3].trim(),
  };
}

async function diffBetween(
  preHash: string,
  postHash: string,
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await runGit(["diff", `${preHash}..${postHash}`, "--", path], { signal });
  return result.stdout;
}

async function diffFilesChanged(
  preHash: string,
  postHash: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const result = await runGit(
    ["diff", "--name-only", `${preHash}..${postHash}`],
    { signal },
  );
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

interface FunctionLocation {
  function_name: string;
  signature_line: number;
  end_line: number;
}

function locateFunction(
  source: string,
  functionName: string,
): FunctionLocation | undefined {
  // functionName is "ClassName::methodName" or just "methodName".
  const lastColon = functionName.lastIndexOf("::");
  const methodName = lastColon >= 0 ? functionName.slice(lastColon + 2) : functionName;
  const className = lastColon >= 0 ? functionName.slice(0, lastColon) : "";
  const lines = source.split("\n");

  const signaturePattern = className
    ? new RegExp(
        `(?:^|[^\\w:])${escapeRegex(className)}::${escapeRegex(methodName)}\\s*\\(`,
      )
    : new RegExp(`(?:^|[^\\w:])${escapeRegex(methodName)}\\s*\\(`);

  let signatureLine = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (signaturePattern.test(lines[index])) {
      signatureLine = index;
      break;
    }
  }
  if (signatureLine < 0) {
    return undefined;
  }

  // Find opening brace at or after signature line, then track depth.
  let depth = 0;
  let started = false;
  let endLine = signatureLine;
  for (let index = signatureLine; index < lines.length; index += 1) {
    const stripped = stripCommentsAndStrings(lines[index]);
    for (const char of stripped) {
      if (char === "{") {
        depth += 1;
        started = true;
      } else if (char === "}") {
        depth -= 1;
        if (started && depth === 0) {
          endLine = index;
          return { function_name: functionName, signature_line: signatureLine, end_line: endLine };
        }
      }
    }
  }

  return { function_name: functionName, signature_line: signatureLine, end_line: lines.length - 1 };
}

function escapeRegex(input: string): string {
  return input.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function stripCommentsAndStrings(line: string): string {
  let result = "";
  let inString: false | "\"" | "'" = false;
  let escape = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === inString) {
        inString = false;
      }
      continue;
    }
    if (char === "/" && next === "/") {
      break;
    }
    if (char === "/" && next === "*") {
      // Block comment until */ on the same line; if it spans lines, we conservatively bail.
      const close = line.indexOf("*/", index + 2);
      if (close < 0) {
        break;
      }
      index = close + 1;
      continue;
    }
    if (char === "\"" || char === "'") {
      inString = char;
      continue;
    }
    result += char;
  }
  return result;
}

interface HeuristicOutcome {
  verdict_kind: VerdictKind;
  summary: string;
  matched_line?: number;
  matched_snippet?: string;
  reason: string;
}

function classifyBatteryStatusBounds(
  source: string,
  region: FunctionLocation,
): HeuristicOutcome {
  const lines = source.split("\n");
  // Search inside the function body for the relevant while loop.
  for (let index = region.signature_line; index <= region.end_line; index += 1) {
    const original = lines[index];
    const stripped = stripCommentsAndStrings(original);
    if (!/\bwhile\b/.test(stripped)) continue;
    const mentionsGuard = /cell_count\s*<\s*10/.test(stripped);
    const mentionsRead = /voltages\s*\[\s*cell_count\s*\]/.test(stripped);
    if (!mentionsGuard || !mentionsRead) continue;

    // Determine ordering by position within the same while header.
    const whileStart = stripped.indexOf("while");
    const guardIndex = stripped.search(/cell_count\s*<\s*10/);
    const readIndex = stripped.search(/voltages\s*\[\s*cell_count\s*\]/);
    if (guardIndex < 0 || readIndex < 0 || whileStart < 0) continue;

    if (guardIndex < readIndex) {
      return {
        verdict_kind: "static_evidence_consistent_with_claim",
        summary:
          "The cell_count<10 guard appears before the voltages[cell_count] read in the while-loop header, so the bounds check short-circuits before the array access. This is consistent with the supplier claim that the parser refuses oversize battery payloads before touching the field-copy stage.",
        matched_line: index + 1,
        matched_snippet: original,
        reason: "guard_before_read",
      };
    }
    return {
      verdict_kind: "static_evidence_conflicts_with_claim",
      summary:
        "The voltages[cell_count] read appears before the cell_count<10 guard in the while-loop header, so the array is dereferenced before the bounds check rejects the iteration. This conflicts with the supplier claim that malformed frames are rejected before field copy.",
      matched_line: index + 1,
      matched_snippet: original,
      reason: "read_before_guard",
    };
  }

  return {
    verdict_kind: "static_evidence_inconclusive",
    summary:
      "The handle_message_battery_status function was located, but no while-loop matching the cell_count/voltages pattern from PR #18411 could be classified. The patched code may have been refactored away from the original loop shape.",
    reason: "pattern_not_found",
  };
}

function buildSnippet(source: string, region: FunctionLocation, context: number = 4): SourceRegion {
  const lines = source.split("\n");
  const startLine = Math.max(0, region.signature_line - context);
  const endLine = Math.min(lines.length - 1, region.end_line + context);
  const numbered = lines
    .slice(startLine, endLine + 1)
    .map((line, index) => {
      const lineNumber = startLine + index + 1;
      return `${String(lineNumber).padStart(5, " ")} | ${line}`;
    })
    .join("\n");
  return {
    file_path: "", // filled by caller
    function_name: region.function_name,
    start_line: region.signature_line + 1,
    end_line: region.end_line + 1,
    snippet: numbered,
  };
}

function describeRoleLabel(role?: "pre-patch" | "post-patch"): string {
  if (role === "pre-patch") return "pre-patch parent";
  if (role === "post-patch") return "post-patch fix";
  return "ad-hoc target";
}

function renderSourceContextMarkdown(input: {
  resolved: ResolvedTarget;
  commit: CommitInfo;
  region: SourceRegion;
  heuristic: HeuristicOutcome;
  caseConfig: StaticSourceConfigCase;
}): string {
  const { resolved, commit, region, heuristic, caseConfig } = input;
  const matchedLine = heuristic.matched_line ? `line ${heuristic.matched_line}` : "no specific line";
  const matchedSnippet = heuristic.matched_snippet ? heuristic.matched_snippet.trim() : "(no matching while-loop found)";
  return [
    `# Static Source Context: ${resolved.case_config.target_function}`,
    "",
    `Repository: PX4/PX4-Autopilot`,
    `Pull request reference: ${caseConfig.pr_url} (${caseConfig.pr_title})`,
    `Resolved commit: \`${commit.hash}\` (${describeRoleLabel(resolved.role)})`,
    `Commit subject: ${commit.subject}`,
    `Author date: ${commit.author_date}`,
    `Committer date: ${commit.committer_date}`,
    `Parent commit(s): ${commit.parent_hashes.map((value) => `\`${value}\``).join(", ") || "(none)"}`,
    "",
    `## Target Region`,
    "",
    `File: \`${caseConfig.target_file}\``,
    `Function: \`${caseConfig.target_function}\``,
    `Line range: ${region.start_line}-${region.end_line}`,
    "",
    "```cpp",
    region.snippet,
    "```",
    "",
    `## Heuristic`,
    "",
    caseConfig.heuristic,
    "",
    `## Heuristic Match`,
    "",
    `Verdict: \`${heuristic.verdict_kind}\``,
    `Matched location: ${matchedLine}`,
    "",
    "Matched line content:",
    "",
    "```cpp",
    matchedSnippet,
    "```",
    "",
    heuristic.summary,
    "",
    `## Caveats`,
    "",
    "This is static-source evidence only. The runner did not execute PX4, did not run SITL, did not fuzz the parser, and did not exercise any runtime path. Treat the verdict as a structural source-code observation at the resolved commit, not a runtime safety judgment.",
    "",
  ].join("\n");
}

function renderDiffSummaryMarkdown(input: {
  preHash: string;
  postHash: string;
  filesChanged: string[];
  targetFile: string;
  diffPatch: string;
}): string {
  const { preHash, postHash, filesChanged, targetFile, diffPatch } = input;
  const hunkLines = diffPatch
    .split("\n")
    .filter((line) => line.startsWith("@@"));
  const additions = diffPatch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  const deletions = diffPatch.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---"));
  return [
    `# Diff Summary: ${preHash} → ${postHash}`,
    "",
    `Files changed across the full diff (pre vs post commit):`,
    "",
    ...filesChanged.map((file) => `- \`${file}\``),
    "",
    `## Target File: \`${targetFile}\``,
    "",
    `Hunks observed: ${hunkLines.length}`,
    `Lines added in target file: ${additions.length}`,
    `Lines removed in target file: ${deletions.length}`,
    "",
    "Hunk headers:",
    "",
    ...(hunkLines.length > 0 ? hunkLines.map((line) => `- ${line}`) : ["(no hunks)"]),
    "",
    "Full target-file diff is in `artifacts/diff.patch`.",
    "",
  ].join("\n");
}

function renderFailureMarkdown(input: {
  caseId: string;
  targetCommit: string;
  resolvedHash?: string;
  stage: string;
  detail: string;
}): string {
  const { caseId, targetCommit, resolvedHash, stage, detail } = input;
  return [
    `# Static Source Evidence Failure`,
    "",
    `Case: \`${caseId}\``,
    `Requested target_commit: \`${targetCommit}\``,
    `Resolved commit hash: \`${resolvedHash ?? "(unresolved)"}\``,
    `Failure stage: ${stage}`,
    "",
    `Detail:`,
    "",
    "```",
    detail,
    "```",
    "",
    "## Why this is not fake success",
    "",
    "The static-source runner could not produce real evidence for the requested target. It is explicitly recording that failure here instead of synthesizing a result. Re-run when the network is available or supply a known commit alias.",
    "",
  ].join("\n");
}

export async function produceStaticSourceEvidence(input: {
  case_id: string;
  test_card_id: string;
  target_commit: string;
  signal?: AbortSignal;
  onProgress?: (phase: string, progress: number, message: string) => Promise<void> | void;
}): Promise<StaticSourceOutcome> {
  const config = await loadStaticSourceConfig();
  let resolved: ResolvedTarget;
  try {
    resolved = resolveTarget(input.case_id, input.target_commit, config);
  } catch (error) {
    const err = error instanceof StaticSourceError
      ? error
      : new StaticSourceError(
          error instanceof Error ? error.message : String(error),
          "resolve-target",
          "Failed to resolve target_commit.",
        );
    return {
      kind: "failure",
      failure: {
        verdict_kind: "static_evidence_unavailable",
        summary: `Could not resolve target_commit "${input.target_commit}" for case ${input.case_id}.`,
        caveats: [
          "No PX4 source was inspected for this run.",
          "Static-source evidence only; runtime behavior was not evaluated.",
        ],
        failure_md: renderFailureMarkdown({
          caseId: input.case_id,
          targetCommit: input.target_commit,
          resolvedHash: undefined,
          stage: err.stage,
          detail: err.detail || err.message,
        }),
        target_commit: input.target_commit,
        stage: err.stage,
        detail: err.detail || err.message,
      },
    };
  }

  const caseConfig = resolved.case_config;

  let releaseLock: (() => Promise<void>) | undefined;
  await input.onProgress?.("acquiring-cache-lock", 15, "Waiting for PX4 cache lock.");
  try {
    releaseLock = await acquireCacheLock(input.signal);
  } catch (error) {
    const err = normalizeError(error, "cache-lock");
    return {
      kind: "failure",
      failure: {
        verdict_kind: "static_evidence_unavailable",
        summary: `Could not acquire the PX4 cache lock. ${err.message}`,
        caveats: ["Static-source evidence is unavailable for this run."],
        failure_md: renderFailureMarkdown({
          caseId: input.case_id,
          targetCommit: input.target_commit,
          resolvedHash: resolved.resolved_commit_hash,
          stage: err.stage,
          detail: err.detail || err.message,
        }),
        target_commit: input.target_commit,
        resolved_commit_hash: resolved.resolved_commit_hash,
        stage: err.stage,
        detail: err.detail || err.message,
      },
    };
  }

  try {
    await input.onProgress?.(
      "ensuring-source-checkout",
      25,
      `Ensuring PX4 commit ${resolved.resolved_commit_hash} is in the local cache.`,
    );
    try {
      await ensureCommit(config.repository.url, resolved.resolved_commit_hash, input.signal);
      if (resolved.pair) {
        const otherHash =
          resolved.role === "post-patch" ? resolved.pair.pre_hash : resolved.pair.post_hash;
        if (otherHash && otherHash !== resolved.resolved_commit_hash) {
          await ensureCommit(config.repository.url, otherHash, input.signal);
        }
      }
    } catch (error) {
      const err = normalizeError(error, "ensure-commit");
      return {
        kind: "failure",
        failure: {
          verdict_kind: "static_evidence_unavailable",
          summary: `Could not fetch PX4 commit ${resolved.resolved_commit_hash}. ${err.message}`,
          caveats: [
            "Static-source evidence is unavailable for this run.",
            "If the dev environment has no network access to GitHub, this is expected; re-run when network is available.",
          ],
          failure_md: renderFailureMarkdown({
            caseId: input.case_id,
            targetCommit: input.target_commit,
            resolvedHash: resolved.resolved_commit_hash,
            stage: err.stage,
            detail: err.detail || err.message,
          }),
          target_commit: input.target_commit,
          resolved_commit_hash: resolved.resolved_commit_hash,
          stage: err.stage,
          detail: err.detail || err.message,
        },
      };
    }

    await input.onProgress?.(
      "reading-source",
      55,
      `Reading ${caseConfig.target_file} at ${resolved.resolved_commit_hash.slice(0, 12)}.`,
    );
    let source: string;
    let commit: CommitInfo;
    try {
      source = await readFileAtCommit(resolved.resolved_commit_hash, caseConfig.target_file, input.signal);
      commit = await commitMetadata(resolved.resolved_commit_hash, input.signal);
    } catch (error) {
      const err = normalizeError(error, "read-source");
      return {
        kind: "failure",
        failure: {
          verdict_kind: "static_evidence_unavailable",
          summary: `Could not read ${caseConfig.target_file} at ${resolved.resolved_commit_hash}. ${err.message}`,
          caveats: ["Static-source evidence is unavailable for this run."],
          failure_md: renderFailureMarkdown({
            caseId: input.case_id,
            targetCommit: input.target_commit,
            resolvedHash: resolved.resolved_commit_hash,
            stage: err.stage,
            detail: err.detail || err.message,
          }),
          target_commit: input.target_commit,
          resolved_commit_hash: resolved.resolved_commit_hash,
          stage: err.stage,
          detail: err.detail || err.message,
        },
      };
    }

    await input.onProgress?.("locating-function", 70, `Locating ${caseConfig.target_function} in source.`);
    const location = locateFunction(source, caseConfig.target_function);
    if (!location) {
      return {
        kind: "failure",
        failure: {
          verdict_kind: "static_evidence_unavailable",
          summary: `Could not find ${caseConfig.target_function} in ${caseConfig.target_file} at ${resolved.resolved_commit_hash}.`,
          caveats: [
            "Static-source evidence is unavailable for this run.",
            "The target function may have been renamed or moved in this commit.",
          ],
          failure_md: renderFailureMarkdown({
            caseId: input.case_id,
            targetCommit: input.target_commit,
            resolvedHash: resolved.resolved_commit_hash,
            stage: "locate-function",
            detail: `Function signature pattern not found in target file.`,
          }),
          target_commit: input.target_commit,
          resolved_commit_hash: resolved.resolved_commit_hash,
          stage: "locate-function",
          detail: "Function signature pattern not found in target file.",
        },
      };
    }

    await input.onProgress?.(
      "classifying-evidence",
      85,
      `Applying deterministic heuristic to ${caseConfig.target_function}.`,
    );
    const heuristic = classifyBatteryStatusBounds(source, location);
    const region = buildSnippet(source, location);
    region.file_path = caseConfig.target_file;

    const artifacts: StaticSourceArtifacts = {
      source_context_md: renderSourceContextMarkdown({ resolved, commit, region, heuristic, caseConfig }),
      commit_info: {
        target_commit: resolved.target_commit,
        resolved_commit_hash: commit.hash,
        parent_hashes: commit.parent_hashes,
        subject: commit.subject,
        author_date: commit.author_date,
        committer_date: commit.committer_date,
        repository_url: config.repository.url,
        target_file: caseConfig.target_file,
        target_function: caseConfig.target_function,
      },
    };

    let diffFiles: string[] | undefined;
    if (resolved.pair) {
      const { pre_hash, post_hash } = resolved.pair;
      if (pre_hash !== post_hash) {
        try {
          await input.onProgress?.(
            "computing-diff",
            92,
            `Computing pre/post diff for ${caseConfig.target_file}.`,
          );
          const targetPatch = await diffBetween(pre_hash, post_hash, caseConfig.target_file, input.signal);
          const allFiles = await diffFilesChanged(pre_hash, post_hash, input.signal);
          artifacts.diff_patch = targetPatch;
          diffFiles = allFiles;
          artifacts.diff_summary_md = renderDiffSummaryMarkdown({
            preHash: pre_hash,
            postHash: post_hash,
            filesChanged: allFiles,
            targetFile: caseConfig.target_file,
            diffPatch: targetPatch,
          });
        } catch (error) {
          // Diff failure should not invalidate the rest of the evidence.
          const err = normalizeError(error, "compute-diff");
          artifacts.diff_summary_md = renderDiffSummaryMarkdown({
            preHash: pre_hash,
            postHash: post_hash,
            filesChanged: [],
            targetFile: caseConfig.target_file,
            diffPatch: `(diff failed: ${err.message})`,
          });
        }
      }
    }

    return {
      kind: "evidence",
      evidence: {
        verdict_kind: heuristic.verdict_kind,
        summary: heuristic.summary,
        caveats: [
          "Static-source evidence only: the runner inspected source text, not runtime behavior.",
          "No SITL, fuzzing, or MAVLink replay was performed in this job.",
          "Verdict reflects a narrow deterministic heuristic against a specific while-loop structure; refactors of the same code can produce an inconclusive verdict.",
        ],
        region,
        artifacts,
        resolved,
        commit,
        diff_files_changed: diffFiles,
      },
    };
  } finally {
    try {
      await releaseLock?.();
    } catch (releaseError) {
      const message = releaseError instanceof Error ? releaseError.message : String(releaseError);
      process.stderr.write(`Failed to release PX4 cache lock: ${message}\n`);
    }
  }
}

interface NormalizedError {
  message: string;
  stage: string;
  detail: string;
}

function normalizeError(error: unknown, fallbackStage: string): NormalizedError {
  if (error instanceof StaticSourceError) {
    return { message: error.message, stage: error.stage, detail: error.detail || error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { message, stage: fallbackStage, detail: message };
}

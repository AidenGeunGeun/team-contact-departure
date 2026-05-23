# Contact Departure

Contact Departure is a supplier firmware evidence-orchestration proof of concept for Airbus Fly Your Ideas 2026.

The project shows an agent reading curated public firmware-evidence cases, choosing a methodology card, launching an inspectable evidence job, and summarizing the result with caution and artifacts. The point is not to claim autonomous vulnerability discovery. The point is to show a controlled agent loop where the model can coordinate existing evidence-gathering methods without arbitrary shell or file access.

## What This Proves

- A general coding agent can be narrowed into a domain evidence agent by exposing only project-specific tools.
- Long-running evidence work can be launched as jobs, inspected later, cancelled, and viewed through shared run-folder state.
- The agent and the dashboard inspect the same artifacts instead of hiding tool execution behind a black box.
- One case now produces real evidence from real PX4 source at pinned upstream commits.
- One case now launches a real MAVLink parser-library fuzz runner using pymavlink.
- One case now launches a real PX4 SITL runtime probe that either observes live MAVLink behavior or records why the local environment could not run PX4.

## What This Does Not Claim

- It does not prove firmware safety.
- PX4 SITL runtime probe evidence is bounded to a local headless boot and MAVLink heartbeat observation; it is not full runtime fuzzing or replay.
- Parser-library fuzz evidence uses pymavlink on mutated frames; it does not prove PX4 firmware runtime behavior.
- It does not discover a new vulnerability.
- It does not use real supplier-confidential documents.
- It does not expose a production queue, auth system, signing layer, or attested enclave.

## Quick Demo

```bash
npm install
npm run typecheck
npm run smoke:offline
npm run demo:agent
npm run dashboard
```

1. Run `npm run demo:agent` to watch the agent orchestrate evidence work with the six domain tools.
2. Run `npm run dashboard` to inspect the evidence jobs and artifacts the agent created.

`demo:agent` requires one-time pi auth for `openai-codex`:

```bash
npx pi
# inside pi: /login openai-codex
npm run demo:agent
```

If auth is missing, the command fails with a clear login instruction instead of a stack trace.

For a custom one-shot request:

```bash
npm run agent -- "Evaluate the parser-bounds case at the post-patch alias and summarize cautiously."
npm run agent -- "Run the MAVLink parser library fuzz case with smoke-fast budget and summarize cautiously."
npm run agent -- "Run the PX4 SITL runtime probe case with smoke-fast budget and summarize cautiously."
```

For a model-backed parser-fuzz demo:

```bash
npm run demo:agent -- --parser-fuzz
```

For a model-backed PX4 SITL runtime probe demo:

```bash
npm run demo:agent -- --px4-sitl-probe
```

Each agent run writes local runtime state under `agent-runs/<timestamp>/`:

- `transcript.md` — user prompt, tool activity, final answer
- `summary.json` — run id, timestamps, status, observed job ids

Open the URL printed by `npm run dashboard`.

In the dashboard, select a job whose runner kind is `static PX4 source evidence`. That job is the real-evidence path. It should show:

- PX4 commit hash
- file: `src/modules/mavlink/mavlink_receiver.cpp`
- function: `MavlinkReceiver::handle_message_battery_status`
- source line range
- PR URL for PX4 PR #18411
- artifact previews for source context, commit info, and diff
- the static-only caveat

## Model-Backed Agent Commands

The offline smoke test validates the system without calling a model. To watch the product-facing agent orchestrate evidence work, authenticate pi once:

```bash
npx pi
# inside pi: /login openai-codex
npm run demo:agent
```

You can also run a custom one-shot request:

```bash
npm run agent -- "<your request>"
```

The default model is `openai-codex/gpt-5.5` with thinking `xhigh`, using the ChatGPT Plus/Pro Codex subscription path through pi.

## Agent Tool Surface

The pi runtime is used through the SDK, but its built-in coding tools are not exposed. The model does not get `bash`, `read`, `write`, `edit`, `grep`, `find`, or `ls`.

The only active model-facing tools are:

| Tool | Purpose |
| --- | --- |
| `list_cases` | Show curated evidence cases. |
| `load_case` | Load the exact public-doc snippet and constraints for one case. |
| `list_test_cards` | Show available methodology cards. |
| `launch_evidence_job` | Start a non-blocking evidence job and return a job id. |
| `inspect_job` | Read job status, progress, events, result, and artifact paths. |
| `cancel_job` | Stop a queued or running evidence job. |

This is the core difference from “just ask a coding agent to run commands.” The model chooses among domain methods; it does not receive an arbitrary command surface.

## Evidence Cases

| Case | Current evidence path | Status |
| --- | --- | --- |
| `mavlink-battery-status-bounds` | Real static-source inspection of PX4 PR #18411 commit pair. | Real, static-only evidence. |
| `mavlink-parser-library-fuzz` | Real pymavlink parser-library fuzz on mutated BATTERY_STATUS frames. | Real parser-library action evidence; not PX4 SITL. |
| `px4-runtime-probe` | Real PX4 SITL runtime probe with preflight, setup notes, and MAVLink observation when possible. | Real runtime probe evidence; not proof of firmware safety. |
| `mavlink-ftp-path-handling` | Fake smoke runner that simulates path-handling evidence. | Demo scaffold only. |
| `unclear-telemetry-dropout-claim` | Fake/manual-review smoke runner for vague supplier claims. | Demo scaffold only. |

## Evidence Levels

| Evidence level | Status |
| --- | --- |
| Static PX4 source evidence | Real for PR #18411 parser-bounds case. |
| MAVLink parser-library fuzz evidence | Real, using `pymavlink`; not PX4 SITL. |
| PX4 SITL runtime probe evidence | Real when a local SITL binary is available; otherwise records runtime-unavailable blockers. |
| Fake-smoke evidence | Still scaffold for FTP/vague cases. |

## Real vs Fake

| Area | Real today | Fake / scaffold today |
| --- | --- | --- |
| Agent harness | Real pi SDK session using GPT-5.5 via `openai-codex`. | None. |
| Tool restrictions | Real allowlist: only six domain tools exposed. | None. |
| Job lifecycle | Real detached runner processes, status files, events, cancellation. | Runner outputs may be fake depending on case. |
| Parser-bounds case | Real PX4 source fetch, real pinned commits, real source context, real diff. | Static-only; no runtime execution. |
| Parser-library fuzz case | Real pymavlink install, real seed generation, real mutations, real parser outcomes. | Parser-library only; not PX4 SITL or firmware runtime proof. |
| PX4 runtime probe case | Real preflight, PX4 setup notes, optional headless SITL boot, MAVLink observation when possible. | Runtime probe only; heartbeat observation does not prove firmware safety. |
| FTP case | Job lifecycle and dashboard are real. | Evidence content is simulated. |
| Telemetry vague-claim case | Job lifecycle and dashboard are real. | Evidence content is simulated/manual-review style. |
| Dashboard | Real local read-only viewer over run folders. | Visual polish is intentionally basic for now. |

## Static-Source Evidence Path

The first real case is based on PX4 PR #18411: `mavlink: receiver battery_status prevent out of bounds access`.

Pinned aliases live in `data/static-source-commits.json`:

| Alias | Role | Commit |
| --- | --- | --- |
| `mavlink-battery-status-bounds-pre` | pre-patch | `12670b70f48fbbd9305ad6074d7f95d9853fc63d` |
| `mavlink-battery-status-bounds-post` | post-patch | `7ec7d9d173b3c4aedccdda51cbe670f70686b4b6` |

The runner fetches PX4 into `.cache/px4`, reads the target file at the resolved commit, locates `MavlinkReceiver::handle_message_battery_status`, and checks the ordering of the `cell_count < 10` guard relative to the `voltages[cell_count]` access.

The verdict is deliberately narrow:

- pre-patch source conflicts with the claim because the array read appears before the guard;
- post-patch source is consistent with the claim because the guard short-circuits before the read;
- any refactor that breaks the narrow pattern should return inconclusive rather than guessing.

This is static-source evidence only. It does not prove runtime behavior under SITL, fuzzing, or MAVLink replay.

## MAVLink Parser-Library Fuzz Path

The first real action runner is the MAVLink parser fuzz path for case `mavlink-parser-library-fuzz` with test card `mavlink-parser-fuzz`.

The runner:

1. Ensures a local Python venv under `.cache/pymavlink-venv` with a pinned `pymavlink` version.
2. Generates real MAVLink v2 `BATTERY_STATUS` seed frames.
3. Applies bounded mutations (byte flips, truncation, length/checksum corruption, payload extension).
4. Feeds mutated frames into the real pymavlink decoder.
5. Writes parser-library artifacts and a bounded verdict.

Verdict semantics are deliberately narrow:

- `no_issue_detected` means no parser exception was observed under this parser-library budget.
- `attention_required` means at least one mutated input triggered a parser exception.

This is parser-library evidence only. It does not prove PX4 `MavlinkReceiver` runtime behavior or PX4 SITL safety.

## PX4 SITL Runtime Probe Path

The first real PX4 runtime probe path is case `px4-runtime-probe` with test card `px4-sitl-probe`.

The runner:

1. Writes a preflight report for build/runtime dependencies (git, cmake, make, g++, optional ninja, Python).
2. Reuses `.cache/px4` when present and records whether a `px4_sitl_default` binary already exists.
3. Optionally attempts a PX4 build when the budget profile allows it (`local-default`; `smoke-fast` skips build for stable offline smoke).
4. When a SITL binary is available, starts a headless PX4 instance and attempts a live MAVLink heartbeat observation via pymavlink.
5. Writes runtime probe artifacts and a cautious summary.

Outcome semantics are deliberately narrow:

- `runtime_observed` means a live MAVLink heartbeat was observed from the local PX4 instance.
- `runtime_unavailable` means required prerequisites or a local SITL binary were missing; artifacts explain the blocker.
- `runtime_abnormal` means PX4 appeared to start or partially start, but the expected MAVLink observation did not occur.

This is PX4 runtime probe evidence only. It does not prove firmware safety, parser-bounds fixes at runtime, or vulnerability replay.

## Dashboard

The dashboard is step two: a read-only inspection layer over the run folders the agent creates.

Start it with:

```bash
npm run dashboard
```

Default URL: `http://127.0.0.1:4108`.

Environment overrides:

```bash
DASHBOARD_HOST=127.0.0.1 DASHBOARD_PORT=4109 npm run dashboard
```

The dashboard is read-only. It reads run folders and exposes a small local API:

- `GET /api/health`
- `GET /api/jobs`
- `GET /api/jobs/:job_id`
- `GET /api/jobs/:job_id/events`
- `GET /api/jobs/:job_id/artifacts`
- `GET /api/jobs/:job_id/artifacts/:artifact_name`

There are no POST, PUT, PATCH, or DELETE endpoints.

## Run Folder Contract

Every launched job writes local runtime state under `runs/<job_id>/`:

```text
runs/<job_id>/job.json
runs/<job_id>/status.json
runs/<job_id>/events.jsonl
runs/<job_id>/result.json
runs/<job_id>/artifacts/*
agent-runs/<timestamp>/transcript.md
agent-runs/<timestamp>/summary.json
```

`runs/` and `agent-runs/` are intentionally ignored by git. The agent tools, runner processes, smoke tests, and dashboard all read the same contract.

## Common Commands

| Command | What it proves |
| --- | --- |
| `npm run typecheck` | TypeScript compiles. |
| `npm run smoke:offline` | Tool allowlist, job lifecycle, fake runners, static-source runner, MAVLink parser fuzz runner, PX4 SITL probe runner, cancellation, and artifacts work without model calls. |
| `npm run smoke:operator` | Agent transcript/report formatting works without model calls. |
| `npm run demo:agent` | The product-facing agent orchestrates the parser-bounds case end to end and writes a local transcript. Requires `openai-codex` auth. |
| `npm run demo:agent -- --parser-fuzz` | Same as above, but drives the parser-library fuzz case instead of static-source. Requires `openai-codex` auth. |
| `npm run demo:agent -- --px4-sitl-probe` | Same as above, but drives the PX4 SITL runtime probe case. Requires `openai-codex` auth. |
| `npm run agent -- "<prompt>"` | One-shot natural-language agent run with streaming output and transcript/report artifacts. Requires `openai-codex` auth. |
| `npm run smoke:agent` | Legacy model-backed smoke test for the six-tool loop. Requires `openai-codex` auth. |
| `npm run dashboard` | Starts the local read-only viewer. |
| `npm run smoke:dashboard` | Verifies dashboard health, job detail, artifact fetch, traversal rejection, and blocked mutation methods. |

## Repository Map

```text
data/                         curated cases, methodology cards, pinned PX4 commit aliases
scripts/                      smoke tests and demo validation scripts
src/config.ts                 model/runtime constants
  src/session.ts                pi SDK session setup and system prompt
  src/agent/                    agent operator run loop and transcript/report writers
  src/tools/evidence.ts         six model-facing domain tools
src/domain/catalog.ts         case and test-card loading
src/domain/jobs.ts            job lifecycle, run folders, runner dispatch, cancellation
src/domain/static-source-evidence.ts
                              real PX4 static-source evidence implementation
src/domain/mavlink-parser-fuzz.ts
                              real pymavlink parser-library fuzz implementation
src/domain/px4-sitl-probe.ts  real PX4 SITL runtime probe implementation
src/runners/                  standalone runner entrypoints and Python harness
src/dashboard/                local read-only dashboard server and static UI
runs/                         ignored local evidence job artifacts
agent-runs/                   ignored local agent transcripts and summaries
.cache/                       ignored PX4 checkout/cache and pymavlink Python venv
```

## Suggested Reviewer Walkthrough

1. Read the “Real vs Fake” table above.
2. Run `npm run smoke:offline`.
3. Run `npm run demo:agent` to watch the agent orchestrate evidence and write a transcript.
4. Run `npm run dashboard` and open the URL.
5. Select a `static PX4 source evidence` job.
6. Open `source-context.md` and `diff.patch` in the artifact preview.
7. Confirm the UI shows the static-only caveat.
8. Optionally inspect `agent-runs/<timestamp>/transcript.md` to verify the agent drove the tool loop.

## Current Limitations

- Three cases have real evidence today: static PX4 source, parser-library fuzz, and PX4 SITL runtime probe.
- Static-source evidence does not execute firmware.
- Parser-library fuzz uses pymavlink only; it is not PX4 SITL or handler runtime proof.
- PX4 SITL runtime probe needs Python 3, build tools, and a local PX4 SITL binary for a full runtime-observed result; offline smoke expects the stable runtime-unavailable path when the binary is absent.
- PX4 source is fetched from GitHub, so the static-source runner needs network access unless the cache is already warm.
- The parser fuzz runner needs Python 3 and network access on first run to create the pymavlink venv.
- The local dashboard assumes trusted local run folders and binds to `127.0.0.1` by default.
- The dashboard UI is intentionally functional first; visual polish can come later.

## Next Engineering Moves

Good next steps are:

1. Extend the PX4 runtime probe with handler-specific checks or bounded runtime fuzz once the SITL path is stable.
2. Improve dashboard visual design for presentation.
3. Add a second real runtime case (FTP path handling or telemetry conformance) only after the probe path is stable.

Avoid adding production queue infrastructure, auth, multi-agent hierarchy, or broad AFL/libFuzzer harnesses until the narrow evidence loop has earned it.

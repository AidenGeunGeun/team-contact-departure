# Contact Departure

Contact Departure is a supplier firmware evidence-orchestration proof of concept for Airbus Fly Your Ideas 2026.

The project shows an agent reading curated public firmware-evidence cases, choosing a methodology card, launching an inspectable evidence job, and summarizing the result with caution and artifacts. The point is not to claim autonomous vulnerability discovery. The point is to show a controlled agent loop where the model can coordinate existing evidence-gathering methods without arbitrary shell or file access.

## What This Proves

- A general coding agent can be narrowed into a domain evidence agent by exposing only project-specific tools.
- Long-running evidence work can be launched as jobs, inspected later, cancelled, and viewed through shared run-folder state.
- The agent and the dashboard inspect the same artifacts instead of hiding tool execution behind a black box.
- One case now produces real evidence from real PX4 source at pinned upstream commits.

## What This Does Not Claim

- It does not prove firmware safety.
- It does not run PX4 SITL yet.
- It does not fuzz MAVLink at runtime yet.
- It does not discover a new vulnerability.
- It does not use real supplier-confidential documents.
- It does not expose a production queue, auth system, signing layer, or attested enclave.

## Quick Demo

```bash
npm install
npm run typecheck
npm run smoke:offline
npm run dashboard
```

Open the URL printed by `npm run dashboard`.

In the dashboard, select a job whose runner kind is `static PX4 source evidence`. That job is the real-evidence path. It should show:

- PX4 commit hash
- file: `src/modules/mavlink/mavlink_receiver.cpp`
- function: `MavlinkReceiver::handle_message_battery_status`
- source line range
- PR URL for PX4 PR #18411
- artifact previews for source context, commit info, and diff
- the static-only caveat

## Model-Backed Agent Smoke Test

The offline smoke test validates the system without calling a model. To prove the model can drive the six-tool surface, authenticate pi once:

```bash
npx pi
# inside pi: /login openai-codex
npm run smoke:agent
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
| `mavlink-ftp-path-handling` | Fake smoke runner that simulates path-handling evidence. | Demo scaffold only. |
| `unclear-telemetry-dropout-claim` | Fake/manual-review smoke runner for vague supplier claims. | Demo scaffold only. |

## Real vs Fake

| Area | Real today | Fake / scaffold today |
| --- | --- | --- |
| Agent harness | Real pi SDK session using GPT-5.5 via `openai-codex`. | None. |
| Tool restrictions | Real allowlist: only six domain tools exposed. | None. |
| Job lifecycle | Real detached runner processes, status files, events, cancellation. | Runner outputs may be fake depending on case. |
| Parser-bounds case | Real PX4 source fetch, real pinned commits, real source context, real diff. | Static-only; no runtime execution. |
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

## Dashboard

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
```

`runs/` is intentionally ignored by git. The agent tools, runner processes, smoke tests, and dashboard all read the same contract.

## Common Commands

| Command | What it proves |
| --- | --- |
| `npm run typecheck` | TypeScript compiles. |
| `npm run smoke:offline` | Tool allowlist, job lifecycle, fake runners, static-source runner, cancellation, and artifacts work without model calls. |
| `npm run smoke:agent` | The model can drive the six-tool loop and summarize cautiously. Requires `openai-codex` auth. |
| `npm run dashboard` | Starts the local read-only viewer. |
| `npm run smoke:dashboard` | Verifies dashboard health, job detail, artifact fetch, traversal rejection, and blocked mutation methods. |

## Repository Map

```text
data/                         curated cases, methodology cards, pinned PX4 commit aliases
scripts/                      smoke tests and demo validation scripts
src/config.ts                 model/runtime constants
src/session.ts                pi SDK session setup and system prompt
src/tools/evidence.ts         six model-facing domain tools
src/domain/catalog.ts         case and test-card loading
src/domain/jobs.ts            job lifecycle, run folders, runner dispatch, cancellation
src/domain/static-source-evidence.ts
                              real PX4 static-source evidence implementation
src/runners/                  standalone runner entrypoints
src/dashboard/                local read-only dashboard server and static UI
runs/                         ignored local runtime artifacts
.cache/                       ignored PX4 checkout/cache
```

## Suggested Reviewer Walkthrough

1. Read the “Real vs Fake” table above.
2. Run `npm run smoke:offline`.
3. Run `npm run dashboard` and open the URL.
4. Select a `static PX4 source evidence` job.
5. Open `source-context.md` and `diff.patch` in the artifact preview.
6. Confirm the UI shows the static-only caveat.
7. Optionally run `npm run smoke:agent` to see the model drive the same loop.

## Current Limitations

- Only one case has real evidence today.
- That evidence is static-source inspection only.
- PX4 source is fetched from GitHub, so the static-source runner needs network access unless the cache is already warm.
- The local dashboard assumes trusted local run folders and binds to `127.0.0.1` by default.
- The dashboard UI is intentionally functional first; visual polish can come later.

## Next Engineering Moves

Good next steps are:

1. Add a real lightweight runtime runner once the PX4 environment is ready.
2. Improve dashboard visual design for presentation.
3. Add a second real case (FTP path handling or telemetry conformance) only after the first runtime path is stable.

Avoid adding production queue infrastructure, auth, multi-agent hierarchy, or broad fuzzing until the narrow evidence loop has earned it.

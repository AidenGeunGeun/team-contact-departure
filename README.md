# Contact Departure

**An AI agent with normal workspace autonomy inside a bounded evidence project.**

Contact Departure is a proof of concept for Airbus Fly Your Ideas 2026. It demonstrates a defensible answer to a real problem in aerospace supplier review: how to use AI in firmware verification without letting an LLM be the security judge.

The pitch is three sentences:

- **AI proposes.** The agent reads curated supplier-style cases, launches constrained evidence jobs through the project CLI, watches diagnostics, and writes reasoned judgments.
- **Evidence disposes.** Evidence authority is not the agent's confidence. Real runners produce real artifacts at pinned firmware commits; outcomes come from what the firmware actually did.
- **Replay verifies.** Any completed job or pair can be packaged into a bundle. A reviewer runs one CLI command and re-derives the recorded verdict with no LLM in the loop.

That contract is enforceable in code, not just claimed in slides.

## Contents

1. [What this proves and does not claim](#what-this-proves-and-does-not-claim)
2. [60-second walkthrough](#60-second-walkthrough)
3. [Architecture in one paragraph](#architecture-in-one-paragraph)
4. [Autonomy inside the boundary](#autonomy-inside-the-boundary)
5. [Project CLI](#project-cli)
6. [Evidence cases](#evidence-cases)
7. [The verdict flip demonstration](#the-verdict-flip-demonstration)
8. [Replayable evidence bundles](#replayable-evidence-bundles)
9. [Per-runner detail](#per-runner-detail)
10. [Dashboard](#dashboard)
11. [Folder contract](#folder-contract)
12. [Commands reference](#commands-reference)
13. [Full reviewer walkthrough](#full-reviewer-walkthrough)
14. [Repository map](#repository-map)
15. [Limitations and environment requirements](#limitations-and-environment-requirements)
16. [Deliberately out of scope](#deliberately-out-of-scope)

## What this proves and does not claim

**Proves:**

- A Pi agent can operate autonomously inside a bounded project sandbox with normal workspace tools (read, write, edit, bash, grep, find, ls) while evidence operations go through a project CLI.
- Real PX4 source evidence can be produced at pinned upstream commits and inspected by reviewers.
- A real MAVLink parser-library fuzz runner can exercise pymavlink against mutated frames and capture outcomes.
- A real PX4 SITL runtime probe can either boot PX4 and observe MAVLink behavior or honestly report why the local environment could not.
- A real PX4 BATTERY_STATUS runtime replay can build PX4 at a pinned commit (provenance-gated), deliver a crafted frame, and record what the firmware did.
- Two completed pre/post replay jobs can be compared into a pair artifact whose `verdict_flip_demonstrated` field is `true` only when eight independent conditions all hold (correct roles from hash, proven provenance on both sides, delivered frames, meaningful runtime outcomes, differing outcomes, byte-equal frames, matching budget profile, matching `sanitizers_used`).
- Any completed job or pair can be bundled and replayed by a reviewer without the LLM, with replay rigor honestly labeled per runner kind.

**Does not claim:**

- Firmware safety.
- Autonomous vulnerability discovery.
- Use of real supplier-confidential documents (only public PX4/MAVLink material).
- Production-grade queue, auth, signing, attestation, or enclave infrastructure.
- That a clean runtime replay observation proves a vulnerability is absent.
- That an anomalous runtime replay observation proves a vulnerability is present.

## 60-second walkthrough

```bash
npm install
npm run typecheck
npm run smoke:offline
npm run agent
```

That sequence:

- Verifies the agent's tool surface exposes Pi workspace primitives (read, write, edit, bash, grep, find, ls) and not the legacy eight domain tools.
- Exercises the project CLI (`npm run contact -- ...`) and the full job lifecycle, real static-source evidence, real parser-fuzz evidence, real PX4 SITL probe (graceful runtime-unavailable on machines without a built PX4), real PX4 runtime replay (pre and post), pair comparison, and bundle creation + replay with PASS/FAIL assertions.

The primary interface is Pi TUI / chat plus the project CLI. To inspect artifacts passively:

```bash
npm run dashboard
# default: http://127.0.0.1:4108
```

To watch the agent actually orchestrate (requires one-time `openai-codex` auth via `npx pi` then `/login openai-codex`):

```bash
npm run demo:agent
```

The default model is `openai-codex/gpt-5.5` with thinking `xhigh`, using the ChatGPT Plus/Pro Codex subscription path through pi.

## Architecture in one paragraph

The agent runs in a Pi SDK session with workspace primitives: `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls`. Evidence operations (list cases, launch jobs, watch progress, pair jobs, create bundles) go through `npm run contact -- ...`, invoked via bash. The agent freely reads project source, data catalogs, job artifacts, pair artifacts, bundles, and specs; writes analyst judgments under `agent-judgments/` or `agent-runs/`; and debugs failures by reading logs and rerunning commands. Runners execute as detached child processes writing to `runs/<job_id>/`. The dashboard is a passive artifact viewer over the same folders. Bundle creation packages artifacts into `bundles/<bundle_id>/` with a manifest and a runner-specific replay script under `src/replay/` (which has zero agent/session/LLM imports). A reviewer runs `npm run replay -- <bundle_path>` and gets PASS or FAIL with no model involvement.

## Autonomy inside the boundary

Contact Departure gives the agent normal developer autonomy inside the project/pod sandbox. The boundary is enforced by the environment and the project CLI, not by asking the model to behave.

The agent may read, search, edit notes, run commands, watch jobs, and write reasoned judgments. It may not be treated as the authority on firmware safety. Evidence authority comes from runner artifacts, structural checks, replayable bundles, and human review — not from the agent's prose or confidence.

If replay or structural checks disagree with an agent judgment, that disagreement should surface as a human-review flag.

## Project CLI

Evidence operations are exposed through the project CLI, not as separate LLM tools:

```bash
npm run contact -- help
npm run contact -- cases
npm run contact -- show <case>
npm run contact -- run <case> --target <target> --mode <mode>
npm run contact -- jobs
npm run contact -- job <job_id>
npm run contact -- watch <job_id>
npm run contact -- cancel <job_id>
npm run contact -- pair <job_id_a> <job_id_b>
npm run contact -- bundle <job_or_pair_id>
```

User-facing flags hide internal plumbing:

| CLI flag | Meaning |
| --- | --- |
| `--target pre` / `post` | Maps to pinned PX4 aliases for static-source and runtime-replay cases |
| `--target demo` | Case-appropriate demo run label for probe, fuzz, and fake-smoke cases |
| `--mode smoke` | `smoke-fast` budget profile |
| `--mode local` | `local-default` budget profile |
| `--mode asan` | `asan-default` budget profile (AddressSanitizer build when supported) |

Methodology card selection is automatic for known cases unless `--card` is passed explicitly.

Example workflow the agent should follow:

```bash
npm run contact -- show mavlink-battery-status-bounds
npm run contact -- run mavlink-battery-status-bounds --target post --mode smoke
npm run contact -- watch job-...
npm run contact -- job job-...
npm run contact -- bundle job-...
```

## Evidence cases

| Case | Evidence path | Status |
| --- | --- | --- |
| `mavlink-battery-status-bounds` | Real static-source inspection of PX4 PR #18411 commit pair. | Real, static-only. |
| `mavlink-parser-library-fuzz` | Real pymavlink parser-library fuzz on mutated BATTERY_STATUS frames. | Real parser-library action evidence; not PX4 SITL. |
| `px4-runtime-probe` | Real PX4 SITL runtime probe with preflight, setup notes, and MAVLink heartbeat when possible. | Real runtime probe; not firmware safety proof. |
| `mavlink-battery-status-runtime-replay` | Real PX4 SITL runtime replay at pinned pre- or post-patch commit with crafted BATTERY_STATUS frame delivery. | One runtime observation; not safety proof or vulnerability discovery. |
| `mavlink-ftp-path-handling` | Fake smoke runner that simulates path-handling evidence. | Demo scaffold only. |
| `unclear-telemetry-dropout-claim` | Fake/manual-review smoke runner for vague supplier claims. | Demo scaffold only. |

## The verdict flip demonstration

This is the headline. Same case, same methodology card, same crafted MAVLink frame, same budget profile. Only the pinned PX4 commit changes between pre-patch (`mavlink-battery-status-bounds-pre`) and post-patch (`mavlink-battery-status-bounds-post`). Launch two replay jobs via the CLI and pair them:

```bash
npm run contact -- run mavlink-battery-status-runtime-replay --target pre --mode smoke
npm run contact -- run mavlink-battery-status-runtime-replay --target post --mode smoke
npm run contact -- pair <pre_job_id> <post_job_id>
```

**The pair tool refuses to write any artifact** when the pair is structurally invalid:

- Same role on both jobs (two pre-patch or two post-patch).
- Same resolved commit hash.
- Either commit hash does not map to a known role for the case.
- `case_id`, `test_card_id`, or `budget_profile` differ between the two jobs.
- `sanitizers_used` differ between the two jobs (for example one side built with sanitizer instrumentation and the other without).
- Embedded `frame-record.json` bytes differ between the two jobs.

When refusal conditions are not triggered, `pair.json` is written. Its headline field, **`verdict_flip_demonstrated`**, is `true` only when all eight of these conditions hold:

1. Roles correctly derived from `resolved_commit_hash` via lookup against `data/static-source-commits.json` (no lexicographic fallback).
2. Both jobs have `firmware_commit_proven: true` (manifest-verified or freshly built at the pinned commit).
3. Both jobs have `frame_delivered: true` (the crafted frame actually reached PX4).
4. Both jobs ended in a meaningful runtime outcome (`runtime_clean` or `runtime_anomalous`), not `runtime_unavailable`, `runner_failed`, or `cancelled`.
5. Outcomes differ between the two jobs.
6. `frame_bytes_equal` is `true`.
7. `budget_profile_equal` is `true`.
8. `sanitizers_used_equal` is `true` (both jobs used the same sanitizer instrumentation configuration recorded in the build manifest).

If any one condition fails, `verdict_flip_demonstrated` is `false` and `pair.json` records which supporting conditions hold and which do not — a reviewer reading the JSON alone can see exactly what is and is not proven. The dashboard renders the pair side-by-side at `/pair.html?pair_id=...` with `verdict_flip_demonstrated` as the headline indicator and the eight conditions as a checklist.

This is one firmware-driven runtime difference against one crafted frame. It is not vulnerability discovery and not a safety claim. The outcome comes from what PX4 actually does at runtime; the runner does not hardcode pre-patch as anomalous or post-patch as clean.

**Producing a live `verdict_flip_demonstrated: true` pair requires verified PX4 builds at both commits on the local machine.** For the headline runtime flip on the bounds-test frame, use `budget_profile: "asan-default"` so PX4 is built with AddressSanitizer enabled; without sanitizers the pre-patch path may stay `runtime_clean` on both sides. Offline smoke uses `smoke-fast` budget which skips PX4 builds; in that mode the live pair reports `verdict_flip_demonstrated: false`. The pair tool's logic is proven against synthetic fixtures in offline smoke, including the `verdict_flip_demonstrated: true` true-path (with and without sanitizer metadata), refusal of every invalid pair composition (same role, same hash, unmapped role, case/card mismatch, budget mismatch, mixed sanitizers, frame mismatch), and bundle replay refusal when `pinned_inputs.sanitizers_used` does not match the local build manifest.

## Replayable evidence bundles

A reviewer should not have to trust the agent's summary. After a job or pair reaches a terminal state, package it with the CLI:

```text
bundles/<bundle_id>/manifest.json   # canonical record (schema_version 1)
bundles/<bundle_id>/result.json     # job result, or pair.json for pair bundles
bundles/<bundle_id>/artifacts/      # embedded artifact copies
bundles/<bundle_id>/replay.sh       # thin wrapper around the CLI replay entrypoint
bundles/<bundle_id>/README.md       # human-readable summary and replay command
```

Replay is **CLI only** — intentionally not an agent tool, not a dashboard action:

```bash
npm run replay -- bundles/<bundle_id>
```

Replay scripts live under `src/replay/` and import zero agent/session/pi/LLM modules. That isolation is asserted by `grep -r "@earendil-works\|createAgentSession\|getModel" src/replay/` returning nothing.

| Runner kind | Replay kind | What replay proves |
| --- | --- | --- |
| `fake-smoke` | trivial | Re-derives the verdict string deterministically from inputs. |
| `static-source-evidence` | full | Re-fetches PX4 at `pinned_inputs.px4_commit_hash`, verifies the resolved hash matches, and re-runs the source-pattern check. |
| `mavlink-parser-fuzz` | full (if local venv has the pinned pymavlink version) | Verifies the venv's installed pymavlink equals `pinned_inputs.pymavlink_version`; refuses with both versions named on mismatch; otherwise re-runs the harness with the pinned random seed. |
| `px4-sitl-probe` | partial | Re-runs preflight against the current environment and compares findings to the bundled preflight; reports still-hold and differ entries; does not re-boot PX4. |
| `px4-runtime-replay` | partial (full only when a verified PX4 build manifest matches the recorded commit and `sanitizers_used`) | Verifies frame bytes and artifact structure; refuses replay when pinned `sanitizers_used` differs from the local build manifest; can optionally re-deliver the frame when commit and sanitizer configuration match. |
| `pair` | full | Recomputes `pair.json` from embedded job results, byte-compares the result, and byte-compares the embedded frame records. |

**Honesty contract:** partial replay paths do not say "Verdict match" — replay output for those paths explicitly says "Verdict not re-derived; bundled record and re-evaluable signals verified." Tampering with `manifest.json` (for example changing the recorded verdict) causes replay to exit non-zero with a clear FAIL line. Offline smoke exercises tampered-verdict, pymavlink-version-mismatch, static-source-commit-mismatch, runtime-replay-sanitizer-mismatch, and pair-frame-tamper failure cases.

## Per-runner detail

### Static-source evidence (`mavlink-battery-status-bounds`)

Based on PX4 PR #18411: *"mavlink: receiver battery_status prevent out of bounds access."*

Pinned aliases in `data/static-source-commits.json`:

| Alias | Role | Commit |
| --- | --- | --- |
| `mavlink-battery-status-bounds-pre` | pre-patch | `12670b70f48fbbd9305ad6074d7f95d9853fc63d` |
| `mavlink-battery-status-bounds-post` | post-patch | `7ec7d9d173b3c4aedccdda51cbe670f70686b4b6` |

The runner fetches PX4 into `.cache/px4`, reads the target file at the resolved commit, locates `MavlinkReceiver::handle_message_battery_status`, and checks the ordering of the `cell_count < 10` guard relative to the `voltages[cell_count]` access. Pre-patch source conflicts with the supplier claim because the array read appears before the guard; post-patch source is consistent with the claim because the guard short-circuits before the read; any refactor breaking the narrow pattern returns inconclusive rather than guessing. Static-source evidence does not prove runtime behavior under SITL, fuzzing, or MAVLink replay.

### MAVLink parser-library fuzz (`mavlink-parser-library-fuzz`)

The runner ensures a local Python venv under `.cache/pymavlink-venv` with a pinned `pymavlink` version, generates real MAVLink v2 `BATTERY_STATUS` seed frames, applies bounded mutations (byte flips, truncation, length/checksum corruption, payload extension), feeds them into the real pymavlink decoder, and writes parser-library artifacts. Verdict `no_issue_detected` means no parser exception observed under budget; `attention_required` means at least one mutated input triggered a parser exception. Parser-library evidence does not prove PX4 `MavlinkReceiver` runtime behavior.

### PX4 SITL runtime probe (`px4-runtime-probe`)

The runner writes a preflight report for build/runtime dependencies (git, cmake, make, g++, optional ninja, Python), reuses `.cache/px4` when present, optionally attempts a PX4 build when `local-default` budget allows, starts headless PX4 SITL when a binary is available, and attempts a live MAVLink heartbeat observation via pymavlink. `runtime_observed` means a live heartbeat was seen; `runtime_unavailable` means prerequisites or a local SITL binary were missing; `runtime_abnormal` means PX4 appeared to start but the expected observation did not occur. Runtime probe evidence does not prove firmware safety or parser-bounds fixes at runtime.

### PX4 BATTERY_STATUS runtime replay (`mavlink-battery-status-runtime-replay`)

The runner resolves `target_commit` to a pinned PX4 hash, writes preflight, records the exact crafted frame bytes (`frame-record.json`, `frame-record.hex`), checks out PX4 at the resolved commit, builds or reuses `px4_sitl_default` when budget allows (`asan-default` enables AddressSanitizer via the documented PX4 build switch when available, with fallback sanitizer build paths recorded explicitly), boots headless PX4 SITL, waits for MAVLink, delivers the bounds-test frame via pymavlink, and observes whether PX4 stays up. `runtime_clean` means PX4 booted, the frame was delivered, and no crash, abnormal log markers, or sanitizer findings were observed in the observation window. `runtime_anomalous` means the frame was delivered but PX4 exited, logged abnormal markers, or sanitizer instrumentation reported findings (PX4 may still be running when only sanitizers fired — structural instrumentation evidence, not a crash-exit verdict). `runtime_unavailable` means prerequisites or a verified build manifest were missing. Binary provenance is enforced: the runner refuses to claim a commit association without a manifest-verified or freshly-built binary at that commit with matching `sanitizers_enabled` (`firmware_commit_proven` and `sanitizers_used` reflect this honestly).

### Fake-smoke (FTP path handling, vague telemetry claim)

Demo scaffold only. Job lifecycle, status files, events, cancellation, dashboard rendering, and bundle/replay paths are all real. Evidence content is simulated. Useful for exercising the orchestration plumbing without real firmware dependencies.

## Dashboard

Passive read-only artifact viewer over run folders, pair artifacts, and bundles. It is secondary to Pi TUI / chat plus the project CLI.

```bash
npm run dashboard
# default: http://127.0.0.1:4108
# override: DASHBOARD_HOST=127.0.0.1 DASHBOARD_PORT=4109 npm run dashboard
```

API surface (all GET, no mutation endpoints):

- `GET /api/health`
- `GET /api/jobs`, `GET /api/jobs/:job_id`
- `GET /api/jobs/:job_id/events`, `/artifacts`, `/artifacts/:artifact_name`
- `GET /api/pairs`, `GET /api/pairs/:pair_id`
- `GET /api/bundles`, `GET /api/bundles/:bundle_id`

Pages:

- `/` — job list and detail.
- `/pair.html?pair_id=<pair_id>` — side-by-side verdict flip view with the eight-condition checklist.
- `/bundles.html` — bundle list.
- `/bundle.html?bundle_id=<bundle_id>` — manifest, artifact paths, and the exact `npm run replay` command.

The dashboard does not run replay. Visual polish is intentionally functional; the goal is honest information density.

## Folder contract

```text
runs/<job_id>/job.json
runs/<job_id>/status.json
runs/<job_id>/events.jsonl
runs/<job_id>/result.json
runs/<job_id>/artifacts/*
pairs/<pair_id>/pair.json
bundles/<bundle_id>/manifest.json
bundles/<bundle_id>/result.json
bundles/<bundle_id>/artifacts/*
bundles/<bundle_id>/replay.sh
bundles/<bundle_id>/README.md
agent-judgments/                   ignored: agent analyst notes
agent-runs/<timestamp>/transcript.md
agent-runs/<timestamp>/summary.json
```

`runs/`, `pairs/`, `bundles/`, `agent-judgments/`, `agent-runs/`, and `.cache/` are gitignored. The project CLI, runner processes, smoke tests, dashboard, and replay CLI all read the same contract.

## Commands reference

| Command | What it proves |
| --- | --- |
| `npm run typecheck` | TypeScript compiles. |
| `npm run smoke:offline` | Tool surface (Pi primitives, no legacy domain tools), project CLI checks, job lifecycle, all four real runners, fake runners, pair comparison (including refusal paths and synthetic `verdict_flip_demonstrated: true` fixtures), bundle creation and replay (including mismatch/tamper FAIL fixtures), cancellation, and artifacts work without model calls. |
| `npm run smoke:operator` | Agent transcript/report formatting works without model calls. |
| `npm run smoke:dashboard` | Dashboard health, job detail, pair list and detail API, bundle list and detail pages, artifact fetch, traversal rejection, blocked mutation methods. |
| `npm run contact -- help` | Project CLI help and command surface. |
| `npm run contact -- cases` | List curated evidence cases in plain language. |
| `npm run contact -- run <case> --target <target> --mode <mode>` | Launch an evidence job; print job id and next watch command. |
| `npm run demo:agent` | The product-facing agent orchestrates a case end to end using bash and the project CLI; writes a transcript. Requires `openai-codex` auth. |
| `npm run demo:agent -- --parser-fuzz` | Same, but drives the parser-library fuzz case. |
| `npm run demo:agent -- --px4-sitl-probe` | Same, but drives the PX4 SITL runtime probe case. |
| `npm run agent -- "<prompt>"` | One-shot natural-language agent run with streaming output and transcript/report artifacts. |
| `npm run dashboard` | Starts the local read-only viewer. |
| `npm run replay -- bundles/<bundle_id>` | Re-derives the bundle verdict with no LLM. Prints PASS or FAIL. |

## Full reviewer walkthrough

For a 10–15 minute review:

1. **Read this README's opening pitch and the "what this does not claim" list.** Calibrate expectations.
2. **`npm install && npm run typecheck && npm run smoke:offline`.** Watch the offline smoke pass. It exercises every real evidence path, the project CLI, Pi primitive tool surface, pair refusal cases, and bundle/replay PASS/FAIL on tampered inputs without calling a model.
3. **`npm run dashboard`** in another shell. Open `http://127.0.0.1:4108`.
4. **Inspect a `static-source-evidence` job.** Open `source-context.md`, `commit-info.json`, and `diff.patch` in the artifact preview. Confirm the static-only caveat appears in the result summary.
5. **Inspect a `mavlink-parser-fuzz` job.** Open `evidence-summary.md` and `parser-outcomes.csv`. Confirm the parser-library-only caveat.
6. **Inspect a `mavlink-battery-status-runtime-replay` job.** Open `frame-record.hex`, `delivery-record.json`, and `runtime.log`. Note that on a machine without a verified PX4 build, the outcome is `runtime_unavailable` with `firmware_commit_proven: false` — that is the honest local result, not a failure.
7. **Open a pair page** at `/pair.html?pair_id=<some-pair-id>` from the dashboard list. Note the eight-condition checklist and the explicit `verdict_flip_demonstrated` indicator. Without a verified PX4 build, the indicator is `false` because runtime outcomes are not meaningful — this is the honesty contract working.
8. **Open the bundles list** at `/bundles.html`. Pick a bundle, open it, copy the replay command from the detail page.
9. **Run `npm run replay -- bundles/<bundle_id>`.** Note PASS for an untampered bundle. For static-source and parser-fuzz bundles, replay actually re-derives the verdict. For SITL/runtime bundles, replay re-evaluates what it can and reports "Verdict not re-derived; bundled record and re-evaluable signals verified" — that wording is deliberate.
10. **Optional:** authenticate `pi` with `npx pi` then `/login openai-codex`, run `npm run demo:agent`. Watch the agent use bash and `npm run contact -- ...` to orchestrate evidence work. Read `agent-runs/<timestamp>/transcript.md` to see the tool sequence the model chose.

The reviewer's working mental model after this walkthrough: the agent operates autonomously inside the sandbox, the project CLI launches evidence work, the runners produce real artifacts, the pair tool refuses to lie, and bundle + CLI replay verifies independently.

## Repository map

```text
data/                              curated cases, methodology cards, pinned PX4 commit aliases, runner configs
scripts/                           smoke tests, demo validators, replay and contact CLI entrypoints
src/config.ts                      model/runtime constants
src/session.ts                     pi SDK session setup, system prompt, primitive tool allowlist
src/cli/contact.ts                 project CLI for evidence operations
src/agent/                         agent operator run loop, transcript/report writers
src/tools/evidence.ts              domain operation helpers (used by CLI and smoke tests)
src/domain/catalog.ts              case and test-card loading
src/domain/jobs.ts                 job lifecycle, run folders, runner dispatch, cancellation
src/domain/static-source-evidence.ts   real PX4 static-source evidence
src/domain/mavlink-parser-fuzz.ts      real pymavlink parser-library fuzz
src/domain/px4-sitl-probe.ts          real PX4 SITL runtime probe (preflight helper also reused at replay time)
src/domain/px4-runtime-replay.ts      real PX4 runtime replay with provenance gate
src/domain/evidence-pair.ts           pair comparison with eight-condition gate
src/domain/evidence-bundle.ts         bundle packaging
src/runners/                       standalone runner entrypoints and Python harnesses
src/replay/                        CLI replay per runner kind (no agent imports — strict isolation)
src/dashboard/                     local read-only dashboard server and static UI
runs/                              ignored: per-job artifacts
pairs/                             ignored: per-pair JSON artifacts
bundles/                           ignored: per-bundle packaging
agent-runs/                        ignored: agent transcripts and summaries
.cache/                            ignored: PX4 checkout, pymavlink venv
specs/                             ignored: planning specs (kept local for development history)
```

## Limitations and environment requirements

- **Live PX4 runtime requires local build environment.** `npm run smoke:offline` uses `smoke-fast` budget which skips PX4 builds and exercises the runtime-unavailable path stably. For `runtime_observed` from the SITL probe or `runtime_clean` from runtime replay, the machine needs Python 3, build tools (git, cmake, make, g++; ninja recommended), and either a prepared `.cache/px4/build/px4_sitl_default/bin/px4` with a matching build manifest or the bandwidth/time to fetch and build PX4 on first run.
- **Live `verdict_flip_demonstrated: true` requires verified builds at both commits.** Use `asan-default` when you need sanitizer-instrumented runtime evidence; sanitizer builds are slower and are typically run on a Linux CPU host with a full PX4 toolchain. The pair tool's strict gate refuses to claim a flip without `firmware_commit_proven: true` on both sides, matching `sanitizers_used`, and meaningful runtime outcomes (not `runtime_unavailable`). Offline smoke does not run real ASan PX4 builds; synthetic fixtures prove the eight-condition gate and refusal paths. Producing a live true pair on instrumented firmware is an environment exercise (often a rented Linux CPU pod).
- **Static-source replay needs network for the first PX4 fetch** unless `.cache/px4` is already warm. Subsequent replays of the same commit are offline.
- **Parser-fuzz replay needs the local venv with the pinned pymavlink version.** Replay refuses with both versions named if the installed pymavlink differs from `pinned_inputs.pymavlink_version`.
- **Partial replay (SITL probe, runtime replay without verified build) does not prove runtime behavior on its own.** It re-evaluates what it can (preflight, artifact structure, recorded inputs) and says so explicitly in the report — replay output for partial paths never claims "Verdict match."
- **Dashboard binds to `127.0.0.1` by default.** It assumes trusted local run folders. There is no auth, no signing, no remote-access hardening.
- **The dashboard UI is functional first.** Visual polish is intentionally deferred.

## Deliberately out of scope

These are named explicitly because their absence is a feature of this PoC, not an oversight:

- **Hardware-attested enclaves for supplier-IP confidentiality.** Round 1 pitched this. The PoC does not build it. The system would sit *inside* such an enclave in a real deployment, with the I/O surface (doc-in, signed-verdict-out, no binary-out) matching what an enclave requires — but the enclave itself is acknowledged as future work.
- **Behavioral fingerprinting / cross-supplier baseline.** Round 1 also pitched this. Not built. Future work.
- **Real supplier-confidential documents.** Only public PX4 / MAVLink material is ingested. No NDA-locked content.
- **Autonomous vulnerability discovery.** The PoC re-discovers known patched bugs to demonstrate the orchestration shape. It does not claim to find new vulnerabilities.
- **Production scaffolding.** Authentication, secrets management, multi-tenancy, signed bundles, signing keys, attestation chains. Acknowledged; not built.
- **Multi-agent / orchestrator hierarchy inside the PoC.** One pi session per evidence-gathering run. No PM-Orchestrator-Specialist nesting inside the product; the sandbox boundary and project CLI enforce discipline.
- **Broad fuzzing harnesses (AFL/libFuzzer/etc.) against PX4 runtime.** Out of scope for this PoC milestone. The parser-library fuzz and runtime replay paths are the bounded, defensible action evidence today.
- **Cross-machine bundle portability testing.** Bundles are designed to be portable in principle (manifest + artifacts + replay script) but production-grade portability testing is not part of this PoC.

The combination of "what this proves" plus "deliberately out of scope" is the PoC's defensible footprint. A reviewer should leave with both halves of that picture.

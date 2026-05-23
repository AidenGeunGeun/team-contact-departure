# Contact Departure

Supplier firmware evidence-orchestration PoC for Airbus Fly Your Ideas 2026.

The current milestone is a local evidence-job loop with a read-only dashboard. It proves the agent can browse curated cases, choose a methodology card, launch a non-blocking evidence job, inspect progress/results, and show the supporting artifacts without exposing arbitrary coding tools.

## Current Shape

- Runtime: `@earendil-works/pi-coding-agent` via SDK.
- Default model: `openai-codex/gpt-5.5` with thinking `xhigh`.
- Built-in pi coding tools are disabled by allowlisting only project tools.
- Active project tools: `list_cases`, `load_case`, `list_test_cards`, `launch_evidence_job`, `inspect_job`, and `cancel_job`.
- No arbitrary shell, file read, or file write surface is exposed to the model.
- Evidence jobs write ignored runtime artifacts under `runs/<job_id>/`.
- `mavlink-battery-status-bounds` uses real static PX4 source evidence at pinned commits for PR #18411. This is static-source only: no SITL, fuzzing, or runtime replay.
- Demo fake-runner jobs are labeled as smoke evidence and should not be treated as real PX4 runtime evidence.
- The dashboard reads existing run folders only. It has no launch, cancel, update, shell, or arbitrary file-browsing endpoint.

## Commands

```bash
npm install
npm run typecheck
npm run smoke:offline
npm run dashboard
npm run smoke:dashboard
```

`npm run dashboard` starts a local viewer and prints its URL. Open it to inspect job state, progress events, verdicts, static-source metadata, and text/diff/JSON artifact previews from `runs/<job_id>/`.

`npm run smoke:dashboard` starts the dashboard on an ephemeral local port, verifies health/list/detail/artifact endpoints, and creates a deterministic fake smoke-run artifact only if no suitable run artifact exists.

To run the model-backed smoke test, authenticate pi to your ChatGPT Plus/Pro subscription first:

```bash
npx pi
# then run: /login openai-codex
npm run smoke:agent
```

## Run Folder Contract

Each job has a folder shaped like this:

```text
runs/<job_id>/job.json
runs/<job_id>/status.json
runs/<job_id>/events.jsonl
runs/<job_id>/result.json
runs/<job_id>/artifacts/*
```

`runs/` is local runtime state and is intentionally ignored by git.

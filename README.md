# Contact Departure

Supplier firmware evidence-orchestration PoC for Airbus Fly Your Ideas 2026.

The current milestone is a small fake evidence-job loop. It proves the agent can browse curated cases, choose a methodology card, launch a non-blocking smoke job, inspect progress/results, and cancel work without exposing arbitrary coding tools.

## Current Shape

- Runtime: `@earendil-works/pi-coding-agent` via SDK.
- Default model: `openai-codex/gpt-5.5` with thinking `xhigh`.
- Built-in pi coding tools are disabled by allowlisting only project tools.
- Active project tools: `list_cases`, `load_case`, `list_test_cards`, `launch_evidence_job`, `inspect_job`, and `cancel_job`.
- No arbitrary shell, file read, or file write surface is exposed to the model.
- Fake evidence jobs write ignored runtime artifacts under `runs/<job_id>/`.

## Commands

```bash
npm install
npm run typecheck
npm run smoke:offline
```

To run the model-backed smoke test, authenticate pi to your ChatGPT Plus/Pro subscription first:

```bash
npx pi
# then run: /login openai-codex
npm run smoke:agent
```

## Next Milestone

Replace the fake smoke runner with the first real evidence runner shape. PX4/SITL, dashboard work, Docker, and replay bundles remain out of scope until this tool loop is reviewed.

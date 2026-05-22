# Contact Departure

Supplier firmware evidence-orchestration PoC for Airbus Fly Your Ideas 2026.

The first milestone is intentionally small: a pi-coding-agent SDK session with all built-in coding tools disabled and one harmless project tool (`ping`) enabled. This proves the harness shape before we add evidence jobs.

## Current Shape

- Runtime: `@earendil-works/pi-coding-agent` via SDK.
- Default model: `openai-codex/gpt-5.5` with thinking `xhigh`.
- Built-in pi coding tools are disabled by allowlisting only project tools (`tools: ["ping"]`).
- Active project tool today: `ping` only.
- No arbitrary shell, file read, or file write surface is exposed to the model.

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

Replace the smoke tool with the first evidence-job surface:

- `load_case`
- `list_test_cards`
- `launch_job`
- `get_job_status`
- `get_job_result`
- `cancel_job`

The first runner can be fake/smoke-only. Real PX4 jobs come after the job lifecycle is proven.

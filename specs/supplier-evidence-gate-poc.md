# Supplier Evidence Gate — PoC Spec

## 1. Context

This PoC is the technical deliverable for the Airbus Fly Your Ideas 2026 Round 2 submission, sitting alongside a 2-minute video, a 10-question questionnaire, and a 4-slide PDF. The team is also submitting the GitHub repository, so the PoC is reviewed both as a running system and as a code artifact a reviewer can browse.

Round 1 pitched a broad autonomous firmware verification pipeline (specification-conformance oracle, behavioral fingerprinting, hardware-attested enclaves) across IMU + data-concentrator classes. Mentor pushback (Prof. Yongdae Kim, KAIST) made the broad framing indefensible: the original deck read as a claim to build the full system, which a 4-person team cannot. Round 2 narrows to a single, defensible piece: the **orchestration layer** that turns supplier-style documentation into typed, replayable evidence — anchored on a single well-studied firmware target (PX4/ArduPilot in SITL).

The principle the PoC must embody at every layer: **"AI proposes, replay evidence disposes."** The agent is a router and recorder, not a security judge. Every verdict the system emits must be reproducible without the LLM in the loop.

## 2. Outcome

A running agent that:

1. Ingests a public PX4 or MAVLink documentation fragment.
2. Extracts one or more **behavioral claims** from it — structured, testable statements about firmware behavior.
3. Maps each claim to one entry in a **fixed catalog of test recipes** (each tied to an existing published methodology).
4. Executes the recipe against a **pinned PX4 SITL build** using existing test infrastructure.
5. Classifies the result against a **fixed five-element verdict enum**.
6. Emits a deterministic **evidence bundle** containing the inputs, the pinned tool/firmware versions, the raw artifacts, the verdict, and a standalone replay script that reproduces the verdict without the agent.

A reviewer browsing the repo should be able to find the verdict enum, the recipe catalog, the claim schema, and the bundle schema as named, first-class structures — not buried in glue code.

## 3. Architecture (logical)

**Runtime**: The agent runs inside a [pi-coding-agent](https://github.com/earendil-works/pi) session, embedded via its SDK (`createAgentSession`). pi is a dependency, not a fork; we adapt to its workflows via custom tools and skills rather than modifying its internals. The choice is deliberate: pi gives us a battle-tested tool-calling loop, typed tool registration (`pi.registerTool`), session persistence with forking semantics (which maps directly onto the verdict-flip property in §6), and multi-provider model support, without the bloat of LangChain-class frameworks or the friction of writing the loop from scratch. pi's "no MCP, no sub-agents, no plan mode, no permission popups" philosophy aligns with the PoC's single-agent pipeline shape.

**Default model**: `openai-codex/gpt-5.5` with `thinkingLevel: "xhigh"`. Authentication uses the team's existing ChatGPT Plus/Pro subscription via pi's `openai-codex` OAuth provider (subscription quota, not API billing). The model is reasoning-capable; xhigh thinking is appropriate for the load-bearing LLM stages (claim extraction over substantive documentation, recipe selection from the catalog with all eight contract fields per entry, verdict prose generation with rule-trace context). The default is overridable per stage if a stage proves it does not need xhigh, but xhigh is the starting point and changes downward require evidence the stage's outputs are unaffected.

**Tool exposure to the LLM**: pi's built-in coding-agent tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) are NOT exposed in our configuration. The agent is created with `tools: []` and the LLM's only callable surface is the set of typed recipe-primitive tools we register (one per recipe in §5, plus an ingestor and a bundle-emitter). The LLM cannot read or write arbitrary files, run arbitrary shell commands, or grep the codebase. This is a hard contract, enforced at session creation, and named explicitly in the repo's README so a reviewer understands the runtime exposure.

**No agent hierarchy.** The PoC uses one pi session per evidence-gathering run. There is no PM-Orchestrator-Specialist hierarchy and no spawning of subagents. The pipeline's stages are each one LLM call or one tool execution with a known shape — there is no open-ended exploration that would justify decomposing the agent into layers.

**User-facing surface (optional)**: pi exposes a `session.subscribe()` event stream. A thin web dashboard MAY be built on top of this stream to render the pipeline visually (doc ingest, claim extraction cards, recipe selection, tool execution progress, verdict pill, bundle artifact). The dashboard is a **view** of the agent, not another agent — it does not make decisions and does not appear in the verdict-classification path. Building it is non-blocking for the acceptance criteria in §11; the PoC remains complete with pi's TUI or `--mode json` output as the user surface if the dashboard is descoped.

### 3.1 Pipeline

Six-stage pipeline. Two stages are LLM-driven (claim extraction, recipe selection). Three stages are pure deterministic code (ingest, test execution, bundle emission). One stage is rule-derived with an LLM post-step (verdict classification: the enum is chosen by structural rules over recipe outputs; the LLM generates the human-readable explanation prose *after* the enum is selected, and that prose is non-authoritative — i.e., it does not feed back into the verdict).

| Stage | Role | LLM? |
| --- | --- | --- |
| Ingest | Read doc, chunk into reviewable units | No |
| Claim extraction | Pull structured behavioral claims from chunks | Yes |
| Recipe selection | Map each claim to one recipe in the fixed catalog | Yes |
| Test execution | Run the selected recipe against pinned SITL firmware via wrapped existing tools | No |
| Verdict classification | Structural rules over recipe output choose the verdict enum; LLM optionally generates human-readable prose *after* the enum is chosen | Rule-derived; LLM post-step is prose-only and non-authoritative |
| Bundle emission | Serialize manifest + raw artifacts + replay script | No |

**Tool surface**: typed, named, side-effect-explicit tool calls suitable for any function-calling-capable LLM. The PoC does not run an MCP server, but each tool primitive should be shaped such that promotion to MCP is a wrapping exercise, not a redesign.

**LLM never sees unstructured firmware output.** Test execution returns structured records (tool exit code, named telemetry fields, named crash/sanitizer classes). The LLM reads structured records; it does not parse raw logs or crash dumps.

**MTL policies (relevant to Recipe 3, §5) — the LLM may assist in translating natural-language policy text into MTL, but the resulting MTL formula is stored verbatim in the bundle as the authoritative test oracle. Replay reuses the stored formula. If the LLM cannot produce an unambiguous MTL formula from the policy text, the run terminates with verdict `unclear contract` (§4.3) and the ambiguity is reported.**

## 4. Verdict typology (fixed; do not extend)

Exactly five verdicts. Every run of the system terminates in one of them. The enum is the load-bearing differentiator of the pitch — narrowing or expanding it changes the product.

1. **Pass under budget** — The recipe executed to completion within the configured budget (iterations, time, mutations) and observed no violation of the claim. *Not* a safety statement; a budget-bounded observation.
2. **Negative evidence** — The recipe executed and observed firmware behavior matching the violation shape the claim describes. The recipe declares (per §5) which observable classes of output count as a violation match: crash with sanitizer finding, telemetry value outside declared range, MTL policy violation, filesystem state outside the declared sandbox, or parser-rejection-mismatch. The structural rule that selected this verdict names the specific class observed.
3. **Unclear contract** — The documentation does not admit a testable claim. Either no behavioral statement could be extracted, the statement is too ambiguous to map to a recipe, or natural-language policy text could not be unambiguously translated into a formal oracle. Returned with the specific ambiguity called out and the offending source chunk preserved. No recipe is executed.
4. **Missing evidence** — A claim was extracted and a recipe was selected, but the recipe could not be executed to a meaningful conclusion. The recipe declares (per §5) which preconditions, if absent, trigger this verdict: targeted MAVLink message not exposed in the current SITL configuration, required tool binary unavailable or version-mismatched, parameter outside the modifiable set, target file path not present in the build's filesystem layout.
5. **Not evaluable** — The recipe executed and produced output, but the structural rule cannot select pass-under-budget or negative-evidence from that output. The recipe declares (per §5) which output shapes route here: firmware crashed in a class not declared as a violation match for the claim, telemetry fields required by the rule were absent from the trace, policy formula evaluator returned an undefined result.

Each verdict in the bundle ships with: the structural rule that selected it (named, with the specific clause that fired), the raw artifacts the rule consumed, and an optional LLM-generated prose explanation (non-authoritative).

**Verdicts 3 (unclear contract) and 4 (missing evidence) have evidence shapes too**, even though no full test execution occurred. The bundle for these verdicts contains: the source document reference and the offending chunk, the extraction trace (for unclear contract: what the LLM tried and why it failed; for missing evidence: which precondition check failed and how), and the named structural rule clause. These count as "real artifacts" for the purposes of §11.

## 5. Recipe catalog (initial, fixed at 5)

Each recipe is a parameterized test plan. The LLM picks a recipe from this menu by name; it does not compose new recipes. Each recipe wraps existing published methodology — that lineage is the defense against "the LLM is doing security."

**Every recipe in the catalog MUST declare, in code, the following eight fields** (the declaration itself is part of the deliverable — a reviewer reading the recipe file sees the contract before they see the implementation):

- **Wrapped tool(s)** — named existing infrastructure invoked by this recipe.
- **Accepted claim shape** — the structured pattern of behavioral claim this recipe consumes (e.g., "message-field bounds claim: subject = MAVLink message ID, predicate = field bounded by length field, condition = under arbitrary input").
- **Required parameters** — the named parameters the LLM must fill in from the claim before the recipe can run.
- **Structured output schema** — the named fields the recipe emits to the verdict classifier.
- **Pass-under-budget condition** — explicit rule: when does the recipe's output route to verdict 1?
- **Negative-evidence condition** — explicit rule: which observable output class(es) match the claim's predicted violation shape? At least one must be declared. Allowed classes: sanitizer finding (ASan/UBSan/etc.), crash signal in a named class, telemetry value outside named range, MTL formula evaluator returns *violation* with named global-distance crossing, filesystem state diff outside declared sandbox, parser-rejection-mismatch (firmware accepted input the claim says it should reject, or vice versa).
- **Missing-evidence condition** — explicit precondition list whose failure routes to verdict 4.
- **Not-evaluable condition** — explicit rule for outputs that produce neither pass nor negative-evidence match.

The five recipes:

1. **MAVLink parser bounds** — wraps `pymavlink` + a mutation primitive in the Auterion / 4D-Fuzzer lineage. For claims about message-field validation, length fields, or array bounds. Negative-evidence is gated on a sanitizer or crash class matching out-of-bounds read/write; SITL builds used with this recipe must include the sanitizer that exposes the predicted violation shape, or this recipe routes to missing-evidence.
2. **Parameter range validation** — wraps GCS parameter-set commands in the RVFuzzer lineage. For claims about parameter acceptance, range enforcement, or input validation on configuration commands. Negative-evidence is gated on telemetry deviation outside the claim's declared range, or on the firmware accepting a parameter the claim says it should reject.
3. **Policy-violation check** — wraps the PGFuzz runtime policy engine (runtime checker only; not the static-analysis preprocessor). For claims about temporal/behavioral invariants (parachute deploy logic, GPS failsafe, battery failsafe). The policy is stored in the bundle as a formal MTL formula. The LLM may help translate natural-language policy text into MTL (per §3); the stored formula is authoritative. If the natural-language text cannot be unambiguously translated, the run terminates with verdict 3 (unclear contract) before this recipe executes.
4. **Path traversal / file-handling** — wraps MAVLink FTP exercise + filesystem state inspection. For claims about input sanitization on file paths or filenames. Negative-evidence is gated on observed filesystem state outside a declared sandbox path prefix.
5. **Telemetry conformance** — wraps `autotest` mission scripting + MAVLink telemetry capture. For claims of the form "under input X, telemetry field Y stays within range Z." Negative-evidence is gated on telemetry value crossing the claim's declared range.

## 6. Bundle schema

Every bundle — regardless of which verdict was reached — contains:

- **Manifest JSON** — verdict, structural-rule trace (the named rule and the specific clause that fired), pinned firmware commit hash, pinned tool versions, random seed, runtime config, and (where applicable) claim record, recipe name, and recipe parameters. The LLM's prose explanation, if any, is stored verbatim in the manifest as a non-authoritative field.
- **Source document reference** — path or URL of the ingested doc, plus the exact chunk that was the input to claim extraction.
- **Extraction trace** — for every run: the LLM's claim-extraction output (the structured claim or, where extraction failed, the recorded reason). For runs that invoke Recipe 3, the stored MTL formula is included here as well.
- **Raw artifacts** — for runs that executed a recipe: telemetry trace, tool exit code, crash dump or sanitizer report if any, filesystem diffs if any. For runs that did not execute a recipe (verdict 3 unclear contract; some verdict 4 missing-evidence cases): this section is empty and the manifest's structural-rule trace points to the extraction trace instead.
- **Replay script** — standalone shell or Python script. Given the same pinned firmware build and the same bundle, the script reruns only the deterministic stages: test execution (where applicable) and verdict classification under structural rules. The replay script does not invoke the LLM. The replay script does not regenerate the prose explanation; the manifest's stored prose is preserved as-is or simply omitted from replay output. The verdict produced by replay is rule-derived and is required to match the manifest's verdict exactly.

The replay contract is the heart of the PoC. A reviewer must be able to take a bundle, run one script, and reach the same verdict without trusting the agent.

**Provenance chain requirement (load-bearing)**: For the verdict-flip demonstration (§7, §11.3), the bundles produced against the pre-patch and post-patch firmware builds MUST share — verbatim — the same source document reference, the same source chunk, the same extracted claim record, the same recipe name, and the same recipe parameters. The only inputs that differ across the two bundles are the pinned firmware commit hash and the resulting raw artifacts. This makes the verdict-flip visibly a property of the firmware, not of the agent's choices.

## 7. Target firmware

- **Primary**: PX4 in SITL on Linux. Environment is the builder's call; a 32-vCPU / 128 GB RunPod CPU pod is available and known to fit the PGFuzz runtime checker's footprint.
- **Pinned commits**: at least two builds — one "pre-patch" build that exhibits a known patched bug, one "post-patch" build that does not. These should cover at least one bug among PR #18371 (TRAJECTORY_REPRESENTATION_WAYPOINTS valid_points OOB), PR #18411 (BATTERY_STATUS OOB), or PR #18655 (mavlink_ftp path traversal). The chosen bug's observable violation shape MUST be reachable in SITL with the build's sanitizer or instrumentation configuration; if sanitizer-dependent (as MAVLink parser OOB likely is), the SITL build is compiled with the required sanitizer enabled and that fact is recorded in the bundle's pinned tool versions.
- **Source-doc coverage check**: before the verdict-flip demonstration is considered viable, the builder confirms that at least one piece of public PX4/MAVLink documentation describes the behavior the chosen bug violates, in a form the claim extractor can consume. If no such public doc exists for any of the three candidate bugs, the builder either (a) selects a different bug whose docs do exist, or (b) records this as a missing-evidence case for the candidate bug and proceeds with a different bug for the verdict-flip demo.
- **Stretch**: NASA cFS Aquila as a second target, exercised by at least one recipe replaying CVE-2025-25371 (OSAL path traversal). cFS is included only if PX4 work lands cleanly. Its purpose is to demonstrate that the harness, claim format, recipe interface, and bundle schema are target-agnostic.

## 8. Constraints (hard)

- The LLM MUST NOT select the verdict enum value. Structural rules over recipe output choose the verdict. The LLM writes the prose explanation only.
- The LLM MUST NOT receive unstructured firmware output. All tool wrappers return structured records.
- The recipe catalog is fixed at the values in §5. The LLM picks from the menu. It does not invent new recipes.
- The verdict enum is fixed at the five values in §4. It does not grow.
- All testing occurs in SITL. No physical hardware. No real supplier firmware. No NDA-bearing documents.
- Bundles MUST be deterministic: same pinned firmware + same bundle + same replay script ⇒ identical verdict.
- The agent MUST NOT make security judgments in its outputs. Verdicts are observations under budget, not safety claims.

## 9. Out of scope (labeled boundaries the repo acknowledges)

- **Hardware-attested enclaves.** Round 1 pitched supplier-IP-confidential execution inside attested enclaves. The PoC does not build this. The repo's README and architecture diagram show the agent sitting *inside* a labeled "attested enclave (out of PoC scope)" boundary, with the I/O surface (doc-in, signed-verdict-out, no binary-out) matching what such an enclave would require.
- **Behavioral fingerprinting / cross-supplier baseline.** Round 1's compound-intelligence story across a database of firmware submissions. Not built. Acknowledged as future work.
- **Real supplier evidence.** Only public PX4/MAVLink documentation is ingested. No NDA-locked materials.
- **Novel vulnerability discovery.** The PoC re-discovers known patched bugs to demonstrate the orchestration shape. It does not claim to find new vulnerabilities.
- **Production concerns** — authentication, secrets management, multi-tenancy, signature verification of bundles, signing keys. Acknowledged; not built.
- **Multi-target at delivery.** PX4 is primary. cFS is stretch only.

## 10. Repository expectations

A reviewer browsing the repository should find, as named first-class entities (the exact module/file naming is the builder's call; the *visibility* is the requirement):

- The verdict enum, defined once in a single named location.
- The recipe catalog, with each recipe as a named, self-describing entry — declaring all eight contract fields from §5 (wrapped tools, accepted claim shape, required parameters, structured output schema, pass-under-budget condition, negative-evidence condition, missing-evidence condition, not-evaluable condition).
- The claim schema and the bundle schema, as typed structures.
- The structural rules that map recipe outputs to verdicts, as code a reviewer can read top-to-bottom.
- A README that contains the architecture diagram (including the labeled enclave boundary and the labeled pi runtime boundary), the verdict typology, the recipe catalog, the replay contract, and a "what this is not" section listing the §9 out-of-scope items.
- A README **index** with direct links (anchor or path) to: the verdict enum source, each recipe in the catalog, the claim and bundle schemas, the structural-rule code, the demonstration runs, and the replay script. The "casual browse" criterion in §12 is satisfied by following this index.
- A demonstration script or notebook that runs the agent end-to-end on at least one input doc and produces a bundle on disk.
- A replay script that takes a bundle and re-derives its verdict without LLM involvement.

**Contribution attribution.** The README clearly distinguishes:

- **Third-party runtime**: pi-coding-agent (and its transitive dependencies) provides the agent loop, model registry, auth flow, session persistence/forking, and tool dispatch. This is plumbing; the team did not author it.
- **Team contribution**: the recipe catalog, the verdict typology and structural rules, the claim and bundle schemas, the ingestor, the replay script, the tool-primitive wrappers around existing test infrastructure (PGFuzz runtime checker, pymavlink mutation, autotest, etc.), and the dashboard if built.

A reviewer should be able to tell within a minute which lines are the team's intellectual contribution and which lines are pi's. The pi dependency is configured with `tools: []`, so a reader of the README also knows what the LLM can and cannot do at runtime: only the team-registered recipe tools, nothing from pi's built-in coding-agent surface.

## 11. Acceptance criteria

The PoC is complete when all of the following hold:

1. The agent ingests a public PX4 or MAVLink documentation fragment and emits a typed bundle conforming to the §6 schema.
2. Across the runs included in the repo's demonstration set, at least three of the five verdicts are reached, with bundles that conform to §6 for that verdict's evidence shape. Minimum: one **pass under budget**, one **negative evidence**, one **unclear contract**. The unclear-contract run is exercised by an input doc fragment that is deliberately ambiguous; its bundle contains the source chunk, the extraction trace, and the named structural-rule clause that fired, per §4.3 and §6.
3. **Missing evidence** and **not evaluable** verdicts each have at least one concrete demonstration input recorded in the repo (the input doc + the expected structural-rule clause that will fire), even if not run as part of the headline demonstration set. A reviewer can take the recorded input, run the agent on it, and observe the documented verdict.
4. At least one bug among PR #18371, PR #18411, or PR #18655 is re-discovered against a pre-patch pinned PX4 build, producing **negative evidence**, with the corresponding post-patch build producing **pass under budget** from the same source doc chunk, the same extracted claim record, the same recipe name, and the same recipe parameters — i.e., satisfying the provenance chain requirement in §6. This exercises the verdict-flip property of the system.
5. Every bundle produced in the demonstration set is replayable: running its standalone replay script reproduces the bundle's verdict without invoking the LLM. The replay verdict is byte-equal to the manifest verdict.
6. The repo's structure makes the verdict enum, recipe catalog (with all eight contract fields per recipe), claim schema, and bundle schema discoverable via the README index (§10).
7. The README's architecture section visibly labels the enclave as out-of-scope and the agent as sitting inside that boundary.
8. **Stretch**: at least one recipe replays a cFS CVE (CVE-2025-25371 preferred) against a pinned cFS Aquila build and emits a typed bundle, demonstrating harness portability.

## 12. Verification

For the builder and for the auditor:

- **Determinism check**: run the demonstration set twice with the same seeds. Bundles' verdicts and structural-rule traces are identical. LLM prose may differ word-for-word; the verdict and the rule trace do not.
- **Replay check**: for each bundle in the demonstration set, run its replay script in a clean environment. Verdict matches.
- **Verdict-flip check**: for the chosen patched-bug claim, the pre-patch and post-patch builds produce different verdicts under identical claim + recipe + bundle parameters.
- **Visibility check**: a reader given only the repo README and a 5-minute browse can name the five verdicts, name the five recipes, and locate the claim schema in source.
- **Independence check**: the LLM call is removed from the verdict-classification stage; structural rules alone still produce the same verdict on the same recipe output.

## 13. Risk register

- **PGFuzz install weight**. Full PGFuzz needs LLVM 13 and 64–128 GB RAM for static-analysis bitcode passes. Mitigation: wrap only the runtime policy checker. The MTL evaluator and global-distance metric run on telemetry traces, not on whole-bc analysis.
- **SITL build complexity**. PX4 SITL on a fresh Linux box has nontrivial dependencies. Mitigation: containerize SITL early; pin the build environment.
- **Deterministic test execution**. Real determinism across MAVLink timing and SITL clock is harder than it looks. Mitigation: lock SITL to a fixed time-acceleration factor, pin seeds at every layer, document residual nondeterminism honestly rather than claim perfection.
- **LLM nondeterminism on claim extraction**. Two runs may extract slightly different claims from the same doc. Mitigation: temperature 0 with a fixed model snapshot; cache extracted claims by document hash; the replay script does not re-extract — it reads the cached claim from the bundle.
- **Sanitizer/instrumentation dependence for OOB evidence**. The MAVLink parser-bounds bugs (PR #18371, PR #18411) require a sanitizer build of SITL to surface the OOB read/write as a structured finding. Without it, an OOB read may silently corrupt without triggering a crash, leaving no signal for the structural rule. Mitigation: SITL builds used with Recipe 1 are compiled with the relevant sanitizer enabled; the sanitizer is recorded in the bundle's pinned tool versions; absence routes to missing-evidence per §5 Recipe 1.
- **Known-bug reproducibility**. Patched PRs may have moved upstream in ways that complicate isolating a pre-patch commit (refactors, dependency drift, build-system changes that no longer apply to the older tree). Mitigation: confirm pre-patch buildability for the chosen bug *before* committing to it as the verdict-flip target; have a fallback bug ranked by reproducibility, not novelty.
- **Stale research-tool dependencies**. PGFuzz, RVFuzzer, and 4D-Fuzzer public repos may have rotted (broken dependencies, dead links, version drift). Mitigation: do not depend on running the original research artifacts unmodified; re-implement only the runtime primitives the recipes need (MTL evaluator, parameter-set fuzzer, MAVLink mutation primitive), citing the original methodology. The recipe's documentation cites the published methodology; the recipe's implementation does not require the original code to build.
- **Public documentation may not describe the bug surface**. A patched bug may have no corresponding public PX4/MAVLink doc that an integrator would reasonably treat as a behavioral claim — i.e., the bug is in code, not in spec. Mitigation: source-doc coverage check (§7) before locking in the verdict-flip target; if no usable doc exists for any candidate bug, the demonstration shifts to a bug whose surface is documented (e.g., MAVLink XML field-validation behavior is publicly specified).
- **LLM provider / model drift**. Model snapshots get deprecated; behavior on the same prompt shifts across versions. Mitigation: pin the exact model snapshot ID in the bundle; treat replay across a different model as out-of-contract; document that replay requires the pinned model only for prose-regeneration purposes (the verdict itself is rule-derived and does not require the model at all).
- **Environment/package drift breaking replay**. The replay script depends on pinned tool versions; if a future user can't get those versions, replay fails. Mitigation: include either (a) a container manifest pinning all versions, or (b) a documented version matrix in the README, so a reviewer can stand the environment back up.
- **cFS scope creep**. cFS as a stretch can absorb the build's attention. Mitigation: hard gate — cFS work begins only after all primary acceptance criteria are met.

## 14. Anti-objection posture

The pitch will face one specific reviewer profile (cybersecurity researcher) and one general one (Airbus panel). The repo and the PoC must hold up against both. Three anchors:

- **The agent does not make security judgments.** Verdicts are structural-rule outputs over recipe artifacts. The LLM proposes; replay disposes. This is visible in code, not only in slides.
- **The recipes are wrappers around published methodology.** PGFuzz (NDSS 2021), RVFuzzer (USENIX Security 2019), Auterion 2019 / 4D-Fuzzer parser fuzzing, MAVLink autotest framework. Each recipe's docstring or header cites its lineage.
- **No novel-bug claim.** The demonstration set re-discovers known patched bugs against pre-patch firmware. The system's value is reproducibility and orchestration, not discovery.

# Computer-Use Automation System — Design Report

A capture-once, replay-many computer-use system for legacy back-office banking UIs. Built with TypeScript on Node, an Express server-rendered "Bank Operations Console" (`apps/bank-ops/`) as the automation target, Playwright/Chromium as the live surface, Zod for runtime validation of domain and model contracts, and Vitest for automated unit, contract, and browser integration testing (`npx tsc --noEmit` clean). The system was built and validated against a real LLM and a real browser, not a simulator.

## 1. Architecture

```
DISCOVERY (LLM present)
  Goal → DiscoveryAgent (observe → decide → validate → policy → execute)
       → ModelClient → ModelDecision (Zod-validated)
       → PolicyEnforcedSurface → BrowserSurface → Bank Ops Console
       → GoalVerifier (independent DONE check) → ArtifactRecorder → evidence/artifacts/*.json

REPLAY (LLM absent)
  CapabilityArtifact + params → interpolation & schema validation
       → ReplayEngine (ordered steps, checkpoints, no planning)
       → PolicyEnforcedSurface → BrowserSurface → Bank Ops Console
       → ReplayResult + JSONL evidence
```

**Where the LLM is, and where it is not.** LLM decisions occur exclusively in the DECIDE step of `DiscoveryAgent`. Provider selection and fallback sit behind the technology-neutral `ModelClient` interface; `FallbackModelClient` composes a Gemini primary (`@google/genai`) with a TAMU AI Chat fallback, making failover transparent to the agent loop. Replay never constructs a model client and does not import the agent layer: `ReplayEngine` receives an artifact and a `Surface`, while the replay CLI accepts only artifact paths and `--param` inputs. There is no code path from replay to any provider SDK.

**Why `Surface` is the load-bearing abstraction.** `src/surface/types.ts` is small and technology-neutral (`observe`, `click`, `type`, `read`, `navigate`, `wait`, `screenshot`, `currentUrl`, `isVisible`, `pageText`, `close`) and exposes an immutable `sessionId`. Domain types, the artifact schema, policy, replay, and handoff depend solely on this contract; Playwright types exist only within `BrowserSurface`. One artifact schema describes web and future non-web targets, and escalation passes a live `Surface` session rather than a browser handle, enabling same-session handoff without leaking Playwright abstractions.

**Structural enforcement.** `PolicyEnforcedSurface` wraps any `Surface`: mutating calls (`click`, `type`, `navigate`) are evaluated by `PolicyEngine` before reaching the adapter, while `BrowserSurface` knows nothing about policy. Both CLIs and integration tests execute through this wrapper. `EvidenceLogger` emits structured JSONL events with `runId`, `sessionId`, `stepIndex`, and `controlMode` (`automation | human | paused`).

**The lifecycle, concretely.** A live discovery run ("Find member 10234 and return their current savings balance") produced three model-chosen actions (type into `Member ID:`, click `SEARCH`, click `[ View Accounts ]`). The model reached DONE, and `MemberBalanceVerifier` independently verified the Savings balance as `$8,920.14` from the live accounts page. `ArtifactRecorder` parameterized the ID into `{{memberId}}`, synthesized postconditions from observed URL transitions, validated the artifact, and persisted `evidence/artifacts/lookup-member-savings-balance.json`. The same artifact replayed to `$8,920.14` for `memberId=10234` and for `10235` to obtain `$15,340.89` — proving it is a reusable capability, not a static recording.

## 2. Artifact schema

`CapabilityArtifact` is the reusable unit: `id`, `name`, `description`, semver `version`, `targetApp`, `surfaceType` (`web | legacy-web | desktop`), `entryPoint`, typed `inputs`, ordered `steps`, declared `outputs`, `successCondition`, declarative `expectedBusinessOutcomes`, `policyConstraints`, timestamps, `sourceRunId`, and `tenantOverrideKey`. A schema refinement rejects duplicate input names and step indices, making ambiguous ordering invalid rather than suspicious. Inputs are typed (`string | number | boolean`, `required`, `example`); steps carry an action, optional checkpoints (`element_visible`, `element_contains_text`, `url_matches`, `page_contains_text`), and a discovery `rationale`.

Interpolation is deliberately minimal: `{{parameterName}}` string substitution only. Placeholders must reference declared inputs; missing, extra, mistyped, or malformed placeholders fail before any browser action. Substitution applies to action values, locator values/fallbacks, and checkpoint `expectedValue`. `locator.attributeName` remains literal. With no expression evaluation or template engine, artifacts remain human-reviewable and inert as code.

The member-balance artifact demonstrates this: input `memberId`, three steps, output `savingsBalance` read via a CSS selector, success condition requiring page text `Savings`, and declared business outcome `MEMBER_NOT_FOUND` matching `No member found`. `policyConstraints` declares allowed domains, read-only intent, and maximum duration.

Two honest observations: While step locators use semantic strategies (`label`, `text`), the recorded output locator is a positional CSS selector (`tr:nth-child(3) td:nth-child(3)`) — the weakest link, which is why the schema supports locator fallback chains. Second, the artifact is verifiably free of observed values: automated tests assert `$8,920.14` appears nowhere in output locators or fallbacks, ensuring stale data cannot masquerade as fresh results.

## 3. Determinism & error handling

Replay is deterministic by construction: zero LLM, strict index order, no re-planning, and only explicitly defined retries such as a policy-approved handoff. Before interacting with the surface, the engine re-validates the artifact schema and checks interpolation parameters (presence, types, no extraneous keys). A runtime `entryPoint` override allows replaying against ephemeral or staging environments without mutating recorded provenance, enabling test runs against dynamic ports while preserving `http://localhost:3100/` in the artifact. Checkpoints evaluate before and after steps, business outcomes evaluate after each step, and success conditions with output extraction evaluate at the conclusion.

The caller contract is an explicit result taxonomy: `status` (`success`, `business_outcome`, `denied`, `invalid_input`, `invalid_artifact`, `recoverable_failure`, `hard_failure`) paired with an `OutcomeCategory` (`BUSINESS_OUTCOME`, `HUMAN_DENIAL`, `INVALID_INPUT`, `INVALID_ARTIFACT`, `RECOVERABLE`, `HARD_FAILURE`):

- **success** — `memberId=10234` → `{"savingsBalance": "$8,920.14"}` (`evidence/replay/replay-success-10234.jsonl`).
- **business_outcome** — `memberId=99999` → `status: business_outcome`, category `BUSINESS_OUTCOME`, code `MEMBER_NOT_FOUND`. The CLI exits 0: a business answer is not a failure.
- **denied** — operator refuses a confirmation-gated step → `status: denied`, category `HUMAN_DENIAL`. Explicitly distinct from business outcomes; the protected action never executes.
- **invalid_input / invalid_artifact** — malformed schema, bad parameters, or undeclared placeholders, halted pre-execution.
- **recoverable_failure** — transient timeouts, confirmation boundaries without a configured handoff handler, or session disconnect during human takeover.
- **hard_failure** — unrecoverable checkpoint failures with `expected`/`observed` logged, policy denials without confirmation, or missing elements.

Provider fallback is deliberately narrow. During recorded discovery, Gemini returned HTTP 503 ("This model is currently experiencing high demand"); `FallbackModelClient` classified the failure as transient and exercised the configured fallback path. A recorded discovery run also captured a Gemini 503 and a subsequent fallback failure as a structured `CombinedProviderError`, demonstrating that provider failures are surfaced rather than silently hidden (`evidence/discovery/run-1789775851115.jsonl`). A subsequent discovery run completed the goal in three steps. Fallback covers transient faults only (429/500/502/503/504, timeouts); 4xx client errors and misconfigurations fail fast.

Two limitations: non-typed replay errors rely on message heuristics, and `recoverable_failure` means "caller may retry", not that the engine performed automated recovery.

## 4. Heterogeneity & multi-tenant

The design intends that heterogeneous targets and institutions reuse one artifact schema and execution path. What exists: the `Surface` interface with stable session identity, a `SurfaceFactory` seam, `surfaceType` (`web | legacy-web | desktop`), `targetApp` on artifacts, locator fallback chains in `BrowserSurface`, tenant-aware approval scoping in `ApprovalStore`, `tenantOverrideKey`, typed input parameters, and runtime entry-point overrides.

Explicitly not implemented: adapters beyond Chromium; adapter auto-discovery; tenant override resolution (`tenantOverrideKey` is an inert schema field); per-tenant artifact or policy persistence; and merging artifact policy constraints into the active engine configuration (which comes from `PolicyEnforcedSurface` setup). Multi-tenant reuse is supported through real mechanisms — parameterization, locator fallbacks, and entry-point overrides — rather than demonstrated against a second live tenant.

## 5. Escalation & handoff

When policy returns `require_confirmation`, replay intercepts the error and delegates to `HandoffCoordinator`. It drives an explicit state machine: `requested → waiting_for_human → approved | denied → resumed` (with `abandoned` on missing handler or session loss). The `HumanHandoff` contract is technology-neutral, containing the live `Surface`, its `sessionId`, the proposed action, policy rationale, and approval scope — zero credentials, zero browser handles.

Resolution semantics ensure policy integrity:
- `allow_once` stages an ephemeral approval scope on `PolicyEnforcedSurface` consumed strictly once on retry. `PolicyEngine` re-evaluates the retried action; approval is an evaluation input, never a bypass.
- `allow_and_remember` writes an expirable, scoped record (`actionType` plus tenant, target app, capability, or route) requiring exact matching.
- `deny` yields `status: denied` / category `HUMAN_DENIAL`, halting replay while leaving the session intact.
- Session loss before or during takeover yields `session_unavailable` → `recoverable_failure`.

Same-session continuity is verified via automated integration tests against the Bank Operations Console. Replay hits the protected `[ Reset Web Access Password ]` button (gated by risky route and target patterns). The test asserts `sessionId` remains identical before, during, and after handoff, and verifies the Playwright `Page` object is the exact same reference (`Object.is`) — zero page or browser recreation. Evidence records the full transition: `handoff_requested` (paused) → `human_takeover` (human) → `approval_granted` → `human_returned` → `session_resumed` (automation). The denial variant verifies the reset action never ran and the member page remained unchanged.

Scope honesty: escalation is currently wired into replay. Discovery treats confirmation boundaries as terminal (`needs_human`). The human interface is a programmatic callback and deterministic state machine, not an operator web UI.

## 6. Safety

- **Policy boundary.** `PolicyEnforcedSurface` intercepts mutating calls (`click`, `type`, `navigate`); passive reads pass through. Configuration enforces allowed domains (for current URL and navigation targets), route regexes, allowed action types, risky actions/routes/targets requiring confirmation, and a per-run action ceiling. Invalid route regexes fail at configuration time.
- **Model trust boundary.** Model outputs arrive as `unknown` and undergo strict Zod parsing before reaching any surface call; unexpected types or invalid locators are rejected. The model never receives browser, filesystem, or shell handles. A model's DONE claim is never accepted as success: `GoalVerifier` independently reads the live page, failing the run if verification does not pass.
- **Input and artifact validation.** Schema and parameter interpolation validation precede the first action; parameter substitution contains no evaluation surface.
- **Approval integrity.** Denials and `allow_once` tokens exist only in memory; remembered approvals are strictly scoped, expirable, and inaccessible to the model.
- **Evidence and credentials.** Audit logs are structured JSONL. Observations record URLs, titles, and sizes rather than raw DOM; provider errors are sanitized; credentials reside in local `.env` and never enter artifacts or evidence.
- **PII, precisely.** There is no generic PII redaction engine. Prompts include bounded visible text, discovery logs record input values (e.g. member IDs), and replay logs record outputs (`savingsBalance: "$8,920.14"`). Exposure is bounded by truncated observations, declared capability schemas, and secret scrubbing in provider errors — not an automated redaction layer. For sensitive production data, this remains an acknowledged gap.

## 7. Cuts

- **Additional surface adapters.** `Surface` and its factory are the designed seam, and `surfaceType` models the distinction, but only Chromium is implemented. Desktop adapters require OS-level automation that cannot be validated against the current fixture app.
- **Multi-tenant infrastructure.** Tenant-scoped approvals, override keys, and parameterization exist; tenant configuration resolution, isolated artifact stores, and version drift management do not.
- **Operator UI and production orchestration.** Handoff features a verified contract, state machine, same-session guarantee, and audit trail, but the operator interface is an in-process callback. A production deployment requires session streaming, authentication, and operator tooling.
- **Scale, catalog, and promotion infrastructure.** Runs execute in a single process: no distributed job queues, no catalog service invoking capabilities by name, and no multi-run consensus checking for automatic artifact promotion.
- **Advanced reliability and PII controls.** No automated replay retry/recovery, no target fault injection, no generic PII redaction, and no evidence retention lifecycle. Artifacts remain declarative JSON rather than compiled code, prioritizing human auditability over execution speed.

The through-line is deliberate: a real model discovers a live UI, records a validated, parameterized capability, and replays it deterministically with zero model involvement — distinguishing business outcomes from failures and pausing for human approval on the same live session when policy requires it. Everything above was cut to keep that core loop authentic and verified.

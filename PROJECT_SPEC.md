# PROJECT_SPEC.md — Computer-Use Automation System

> **Source of truth** for all coding agents working on this project.
> Updated: Phase 1B-2 (real LLM discovery agent).

---

## 1. Product Goal

We are building a **computer-use automation system** for financial institutions. The system allows AI agents to operate legacy back-office applications — the kind that have no API — by driving their UI the way a human operator would.

The core concept:

1. **Discovery**: An LLM-driven agent observes a live application surface, reasons about what it sees, and accomplishes a goal by clicking, typing, and navigating — just as a person would.
2. **Artifact recording**: A successful discovery run produces a **capability artifact** — a structured, typed, versioned description of the flow (steps, locators, inputs, outputs, checkpoints).
3. **Deterministic replay**: In production, the artifact is replayed *without the LLM in the loop*. Same inputs → same steps → same outputs. Fast, cheap, reliable.

**The model discovers. The artifact becomes a reusable capability. Deterministic replay is how the AI agent invokes it in production.**

---

## 2. Chosen Target Application

### Bank Operations Console (`apps/bank-ops/`)

A deliberately simple, legacy-looking internal banking application. It stands in for the real enterprise back-office systems the automation would target.

**Technology**: Express + server-rendered HTML. No frontend framework. Monospace fonts, gray backgrounds, table layouts, no test IDs — intentionally legacy-enterprise in feel.

**First workflow**: Search for a member → view member record → view accounts → read savings balance.

**Example goal**: *"Find member 10234 and return their current savings balance."*

**Fixture data** (deterministic):

| Member ID | Name         | Status   | Accounts                                    |
|-----------|-------------|----------|---------------------------------------------|
| 10234     | Jane Doe    | Active   | Checking ****1234 ($2,481.32), Savings ****5678 ($8,920.14) |
| 10235     | Robert Smith | Active   | Checking ****9876 ($512.07), Savings ****3210 ($15,340.89), Money Market ****7777 ($42,100.00) |
| 10236     | Maria Garcia | Inactive | Savings ****8888 ($0.00)                    |
| 99999     | —           | —        | Member not found (business outcome)         |

**Runtime states implemented**:
- ✅ Successful member lookup
- ✅ Member not found (business outcome, not error)
- ✅ Invalid member ID format (validation error)

**Runtime states the architecture supports adding later**:
- Slow loading / timeout
- Session timeout
- Permission denied
- Unexpected confirmation dialog
- Application error

---

## 3. Architecture

```
┌─────────────────────────────────────────────────┐
│                   Agent Layer                    │
│    Goal + Observation → ModelDecision contract   │
│          [Phase 1B-1 — contract only]            │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│                 Policy Engine                    │
│     Allowlist enforcement, risk classification   │
│         Every action passes through here         │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│              Surface Abstraction                 │
│   observe() click() type() read() navigate()    │
│   Technology-neutral interface                   │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│             Surface Adapter                      │
│   BrowserSurface (Playwright)                    │
│   [Future: LegacyWebSurface, DesktopSurface]     │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│            Target Application                    │
│         Bank Operations Console                  │
└─────────────────────────────────────────────────┘
```

**Dependency direction**: Domain types depend on nothing. The surface interface depends only on domain types. Surface adapters depend on the interface + their specific technology (Playwright). The agent/replay layer depends on the surface interface + domain types. The policy engine depends only on domain types.

**Key modules**:

| Module | Path | Purpose |
|--------|------|---------|
| Domain | `src/domain/` | Core types and Zod schemas: actions, goals, observations, artifacts, outcomes, evidence, policy |
| Surface | `src/surface/` | Technology-neutral `Surface` interface + `BrowserSurface` adapter |
| Policy | `src/policy/` | Configurable action allowlist and risk classification |
| Evidence | `src/evidence/` | Structured event logging (in-memory + JSONL file) |
| Agent | `src/agent/` | Discovery agent loop, model contracts, Gemini & TAMU adapters, fallback client, DONE verification |
| Artifact | `src/artifact/` | *Future* — Artifact recording, storage, serialization |
| Replay | `src/replay/` | Deterministic replay engine, checkpoint evaluator, outcome taxonomy |
| Bank Ops | `apps/bank-ops/` | Target application (the thing being automated) |

### Agent contract (Phase 1B-1)

The provider-neutral contract defines:

```typescript
interface ModelClient {
  decide(input: ModelInput): Promise<unknown>;
}
```

The return type is `unknown` because model output is untrusted until parsed and validated. The validation boundary is:

```text
raw model output
  → ModelDecisionSchema.parse(...)
  → validated ModelDecision
  → validated domain Action, if type === ACTION
  → PolicyEnforcedSurface
```

The core agent contracts import no OpenAI, Anthropic, Gemini, Playwright, or browser-specific types.

`ModelInput` is built from technology-neutral data:
- `Goal`
- current `Observation`
- current step index
- remaining step budget
- optional previous structured decisions

`ModelDecision` is structured data only:
- `ACTION` — contains an existing domain `Action`
- `DONE` — terminal success, with optional reason and outputs
- `STUCK` — terminal stuck/needs-human condition, with reason
- `ABORT` — terminal abort/failure condition, with reason

Invalid actions, invalid locators, unknown decision types, missing required fields, and extra fields are rejected before any surface method is called.

### Discovery agent (Phase 1B-2)

The `DiscoveryAgent` (`src/agent/discovery-agent.ts`) implements the real observe → decide → validate → policy → execute loop.

#### Provider architecture

The core agent depends only on the provider-neutral `ModelClient` interface. Provider adapters and fallback logic sit entirely outside the agent loop:

```text
DiscoveryAgent
    ↓
ModelClient (interface: decide(input) => Promise<unknown>)
    ↓
FallbackModelClient (transient failure orchestration)
    ├── GeminiModelClient (primary: @google/genai, gemini-3.8-flash)
    └── TamuModelClient (fallback: OpenAI-compatible chat completions)
```

1. **Gemini (`GeminiModelClient`)**:
   - Primary provider using `@google/genai`.
   - Default model: `gemini-3.8-flash` (configurable via `GEMINI_MODEL`).
   - Credential: `GEMINI_API_KEY`.
   - Structured JSON output constrained to `ModelDecision` schema.

2. **TAMU AI Chat (`TamuModelClient`)**:
   - Secondary / fallback provider using standard OpenAI-compatible `/chat/completions` API shape.
   - Endpoint: `${TAMU_BASE_URL}/chat/completions` (strictly configurable via `TAMU_BASE_URL`, never guessed or hardcoded).
   - Model: strictly configurable via `TAMU_MODEL` (never assumed or invented).
   - Credential: `TAMU_API_KEY` passed via `Authorization: Bearer <key>`.
   - Structured JSON response mode: `response_format: { type: "json_object" }`.
   - Independent validation: Does NOT duplicate Zod validation inside the client; returns `unknown` JSON for parsing by `parseModelDecision()`.
   - Does NOT import Gemini, Playwright, or surface types.

3. **Fallback Wrapper (`FallbackModelClient`)**:
   - Orchestrates primary and secondary `ModelClient` instances.
   - Preserves `ModelClient` interface neutrality (`DiscoveryAgent` cannot tell whether fallback occurred or which provider answered).

#### Fallback semantics & transient error taxonomy

Fallback is strictly limited to **transient infrastructure and provider availability problems**:

| Failure Class | Status / Error Code | Action | Rationale |
|---|---|---|---|
| **Rate Limiting** | HTTP 429 | **Fallback** | Primary quota/rate limit exhausted; fallback may have capacity |
| **Server Overload** | HTTP 503 | **Fallback** | Primary model high demand / temporarily unavailable |
| **Internal Server Error** | HTTP 500 | **Fallback** | Primary provider transient backend defect |
| **Bad Gateway / Gateway Timeout** | HTTP 502, 504 | **Fallback** | Upstream provider proxy/routing disruption |
| **Network Timeout** | `TimeoutError`, `ETIMEDOUT`, `AbortError` | **Fallback** | Network connection or read timed out |
| **Connection Errors** | `ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND` | **Fallback** | Transient transport failure reaching primary |
| **Client Request Error** | HTTP 400 | **Fail Immediately (No fallback)** | Malformed request or invalid payload; must not hide schema defect |
| **Authentication Failure** | HTTP 401 | **Fail Immediately (No fallback)** | Invalid or expired API key; must fail fast |
| **Forbidden / Permission** | HTTP 403 | **Fail Immediately (No fallback)** | Project or credential lacks permission; not transient |
| **Not Found / Bad Path** | HTTP 404 | **Fail Immediately (No fallback)** | Incorrect endpoint or missing model ID |
| **Unprocessable Entity** | HTTP 422 | **Fail Immediately (No fallback)** | Semantic payload error |
| **Missing Configuration** | `Error` | **Fail Immediately (No fallback)** | Missing environment variable; fail clearly without searching external files |

If both primary and fallback fail, `FallbackModelClient` raises a `CombinedProviderError` containing safe diagnostics without leaking credentials or raw request secrets.

If TAMU is not configured in the environment, the factory returns `GeminiModelClient` alone so unconfigured fallback never impedes Gemini-only execution.

#### Provider configuration

All provider credentials and endpoints are read from process environment variables or repository `.env`:

```bash
# Gemini Provider (Primary)
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.8-flash

# TAMU Provider (Fallback — supplied by developer)
TAMU_API_KEY=
TAMU_BASE_URL=
TAMU_MODEL=

# Provider Routing (optional)
LLM_PRIMARY_PROVIDER=gemini    # gemini | tamu
LLM_FALLBACK_PROVIDER=tamu     # tamu | gemini
```

**Model trust boundary**:
```text
Provider API response (unknown)
  → JSON.parse
  → parseModelDecision (Zod validation)
  → validated ModelDecision
  → if ACTION → PolicyEnforcedSurface
  → BrowserSurface
  → Playwright
```

The model never receives Playwright objects, Page objects, browser handles, filesystem access, or shell access. The model only proposes structured actions.

**Independent DONE verification**:
```text
Model says DONE ≠ System assumes success
```

After the model returns DONE, the `GoalVerifier` independently checks actual surface state (URL, page content, extracted values) before the agent reports success. The `MemberBalanceVerifier` checks:
1. URL contains `/accounts`
2. Page text contains "Savings"
3. A dollar amount is extractable near "Savings"

**Discovery state machine**:

```text
IDLE → OBSERVING → DECIDING → POLICY_CHECKING → EXECUTING → VERIFYING → OBSERVING (loop)
                  → SUCCESS (DONE verified)
                  → STUCK
                  → FAILED (DONE unverified, ABORT, errors)
                  → TIMEOUT
                  → MAX_STEPS
```

Terminal states: `SUCCESS`, `BUSINESS_OUTCOME`, `STUCK`, `FAILED`, `TIMEOUT`, `MAX_STEPS`.

Policy denial and confirmation-required conditions are not ordinary browser failures. They produce distinguishable `AgentResult` statuses (`failed` with policy reason, `needs_human`).

**Evidence**: Every step emits structured `EvidenceEvent` records. The `FileEvidenceLogger` writes JSONL to disk. Evidence includes: run_started, observations, action_proposed, action_executed, action_rejected, errors, and run_completed.

**Configurable budgets**: `maxSteps` (default 15), `timeoutMs` (default 120s), `modelTimeoutMs` (default 30s).

**Live demo**:
```bash
GEMINI_API_KEY=<key> npm run agent:discover -- --goal "Find member 10234 and return their current savings balance"
```

The CLI starts an ephemeral bank-ops server by default. Use `--url` for an existing instance.

---

## 4. Surface Abstraction

The `Surface` interface (`src/surface/types.ts`) is the critical architectural seam between automation logic and underlying UI technology.

```typescript
interface Surface {
  observe(): Promise<Observation>;
  click(target: TargetLocator): Promise<void>;
  type(target: TargetLocator, value: string): Promise<void>;
  read(target: TargetLocator): Promise<string>;
  navigate(url: string): Promise<void>;
  wait(options: WaitOptions): Promise<void>;
  screenshot(path?: string): Promise<string>;
  currentUrl(): Promise<string>;
  isVisible(target: TargetLocator): Promise<boolean>;
  pageText(): Promise<string>;
  close(): Promise<void>;
}
```

**Why this matters**: The domain layer, artifact schema, replay engine, and agent all interact with the surface *only* through this interface. They never import Playwright types. This means:

- **`BrowserSurface`** — wraps Playwright for modern/legacy web apps
- **`LegacyWebSurface`** — could wrap Playwright with accessibility-tree-first strategies for apps with non-semantic markup
- **`DesktopSurface`** — could wrap OS-level automation (e.g., `pyautogui`, Windows UI Automation, macOS Accessibility API)

…without changing the artifact schema, replay engine, or agent logic.

### BrowserSurface implementation

`BrowserSurface` (`src/surface/browser-surface.ts`) is the concrete Playwright-backed web adapter. It owns the Chromium browser/context/page lifecycle internally and exposes only the technology-neutral `Surface` contract. Playwright types do not appear in the domain layer or surface interface.

`BrowserSurface.create({ headless })` launches Chromium, creates an isolated browser context, creates a page, and defaults to headless mode for automated tests. `close()` cleans up the page, context, and browser.

`BrowserSurface` implements physical browser operations only. It does not know whether an action is authorized and does not call `PolicyEngine.evaluate()`. Authorization remains the responsibility of `PolicyEnforcedSurface`.

**Locator strategies** support robust element targeting:

| Strategy | Use Case |
|----------|----------|
| `role` | ARIA role + accessible name (accessibility-tree-first) |
| `label` | Form label association |
| `text` | Visible text content |
| `attribute` | Arbitrary HTML attribute, represented as `{ strategy: 'attribute', attributeName: '...', value: '...' }` |
| `css` | CSS selector (most brittle, but sometimes necessary) |
| `coordinates` | Absolute screen coordinates (last resort; only for desktop/screenshot-based) |

Locators support fallback chains: a primary strategy with ordered fallbacks. Attribute locators must keep the attribute name separate from the expected value; encoding both into one string is invalid.

Browser locator resolution is centralized in `BrowserSurface`:
- `role` uses Playwright role lookup. The supported compact representation is the role name alone, or `role[name='Accessible Name']`.
- `label` uses label-based lookup and works for the Bank Ops Member ID field.
- `text` prioritizes interactive role-based button/link matches, then falls back to visible text matching.
- `attribute` uses the explicit `attributeName` + `value` schema.
- `css` uses Playwright CSS locators.
- `coordinates` uses mouse coordinates and is treated as a last resort.

Fallbacks are tried in order only when a locator is unavailable/unresolvable. Browser errors include the attempted operation and locator details.

### Observation normalization

`observe()` converts the current browser page into the technology-neutral `Observation` shape:
- current URL
- page title
- visible body text, truncated to a bounded size
- a bounded list of visible/interactable page elements with text and selected attributes (`id`, `name`, `class`, `type`, `href`, `aria-label`, `role`, `placeholder`)
- timestamp

It intentionally does not dump the full DOM or produce an LLM-specific observation format.

---

## 5. Artifact Model

The `CapabilityArtifact` (`src/domain/artifact.ts`) is the central reusable unit.

| Field | Purpose |
|-------|---------|
| `id` | Unique identifier |
| `name` | Human-readable capability name |
| `description` | What this capability does |
| `version` | Semantic version (e.g., `1.0.0`) |
| `targetApp` | Target application identifier |
| `surfaceType` | `web`, `legacy-web`, or `desktop` |
| `entryPoint` | Starting URL or application path |
| `inputs` | Typed input parameters (what the caller supplies per invocation) |
| `steps` | Ordered actions with pre/post-condition checkpoints |
| `outputs` | Declared outputs to extract (what the caller gets back) |
| `successCondition` | Final checkpoint verifying the goal was met |
| `expectedBusinessOutcomes` | Declarative expected non-success business outcomes, each with a stable code and detection checkpoint |
| `policyConstraints` | Safety metadata (allowed domains, read-only flag, max duration) |
| `createdAt` / `updatedAt` | Timestamps |
| `sourceRunId` | Which discovery run produced this |
| `tenantOverrideKey` | For multi-tenant reuse (see §10) |

Each **step** contains:
- The `action` to perform
- Optional `precondition` / `postcondition` checkpoints
- `rationale` (why the agent chose this step during discovery)

**Design intent**: The artifact is not a raw transcript. It is a reviewed, typed, versioned description that both a human reviewer and a calling AI agent can understand.

### Parameter interpolation

Artifacts may contain deterministic input placeholders using exactly this syntax:

```text
{{parameterName}}
```

Rules:
- `parameterName` must be declared in `inputs` and must match the artifact input naming rules.
- Missing required invocation parameters fail before any UI action executes.
- Extra invocation parameters are rejected.
- Undeclared or malformed placeholders are rejected.
- There is no expression evaluation, template engine, or code execution.
- Interpolation is string-based and deterministic.
- Supported fields are action `value` fields, including navigation URLs, locator `value`, and checkpoint `expectedValue`.
- `attributeName` is intentionally literal because attribute names describe page structure rather than per-invocation data.

Future replay code must call the artifact-level interpolation validation helper before the first surface action.

### Business outcomes

Artifacts can declare expected business outcomes:

```typescript
expectedBusinessOutcomes: [
  {
    code: 'MEMBER_NOT_FOUND',
    description: 'Member ID was valid but no record exists',
    checkpoint: { condition: 'page_contains_text', expectedValue: 'No member found' }
  }
]
```

The intended replay contract is:
- success condition matched → `success`
- declared business outcome checkpoint matched → `business_outcome`
- unhandled recoverable or technical issue → recovery path or `failure`

---

## 6. Deterministic Replay (Phase 1C)

Replay is the production execution path. Given a saved `CapabilityArtifact` and invocation parameters:

```text
CapabilityArtifact + Parameters
          ↓
validateArtifactInterpolation()    <-- Fails fast before any UI interaction
          ↓
     ReplayEngine                  <-- Strictly ordered step execution, zero LLM
          ↓
PolicyEnforcedSurface              <-- Preserves all safety policies & approvals
          ↓
     BrowserSurface                <-- Reuses existing Playwright/Chromium driver
          ↓
Target Application (Bank Operations Console)
```

1. **No LLM in the loop.** Every decision was already made during discovery. The replay engine never imports, instantiates, or calls any `ModelClient` or LLM API.
2. **Deterministic step order.** Actions are executed in strict `step.index` sequence without re-planning or inferring steps.
3. **Runtime entry point flexibility.** While `artifact.entryPoint` is preserved for provenance, `ReplayOptions.entryPoint` allows replaying against ephemeral or staging environments.
4. **Checkpoint verification.** Pre- and post-conditions, success conditions, and declared expected business outcomes are evaluated against the live `Surface` via `evaluateCheckpoint()`.
5. **Structured outcome taxonomy.** Replay returns a `ReplayResult` distinguishing:
   - `success`: Goal achieved and declared outputs extracted.
   - `business_outcome`: Declared business checkpoint met (e.g. `MEMBER_NOT_FOUND`), not an error.
   - `invalid_artifact`: Malformed artifact schema or template syntax.
   - `invalid_input`: Missing, extra, or mistyped invocation parameters.
   - `recoverable_failure`: Transient condition (e.g., timeout or confirmation required).
   - `hard_failure`: Unrecoverable error (e.g., policy denial, element not found, failed checkpoint).
6. **Evidence trail.** Every action, observation, checkpoint result, and failure during replay is recorded using `EvidenceLogger`.

---

## 6.1 Artifact Recording & Persistence (Phase 1D)

Artifact recording bridges the exploratory discovery loop to production deterministic replay:

```text
DiscoveryAgent (executed actions + observations + verified outputs)
          ↓
ArtifactRecorder (extracts inputs, parameterizes {{memberId}}, synthesizes checkpoints)
          ↓
Zod Schema Validation (CapabilityArtifactSchema) + Interpolation Validation
          ↓
Persistence (evidence/artifacts/<id>.json)
          ↓
ReplayEngine (loads persisted artifact, replays without LLM)
```

1. **Passive consumption**: Consumes executed actions from `DiscoveryAgent` rather than re-running or re-planning them.
2. **Reusable parameterization**: Translates concrete values (e.g., `10234`) into `{{memberId}}` using the existing interpolation contract.
3. **Pre-persistence validation**: Validates the synthesized artifact with `CapabilityArtifactSchema` and `validateArtifactInterpolation()` before writing to disk.
4. **Clean persistence & provenance**: Persists structured JSON under `evidence/artifacts/`, preserving discovery `sourceRunId` without logging or persisting credentials.

---

## 7. Error Taxonomy

Errors and outcomes are classified into three categories:

### BUSINESS_OUTCOME
An expected result that the caller needs to know about. **Not a crash.**

Examples: "Member not found", "Account closed", "Insufficient balance"

The replay reports this as a structured result with the specific business outcome, not as an error.

### RECOVERABLE
A transient or known condition that could be resolved by retry or dismissal.

Examples: Dismiss a known dialog, wait/retry on slow load, handle a session refresh.

The replay engine can attempt recovery before escalating.

### HARD_FAILURE
An unrecoverable error that should stop execution and surface a clear, debuggable error.

Examples: Element not found on page, unexpected application error, navigation to unknown page, timeout with no recovery path.

The replay reports the step that failed, what was expected, and what was observed.

---

## 8. Safety

### Policy enforcement architecture

```
Action Proposal (from LLM or Replay)
        │
        ▼
┌──────────────────┐
│  Policy Engine   │  ← configurable, not under LLM control
│  evaluate(action)│
└───────┬──────────┘
        │
   ┌────▼────┐
   │ allow?  │──deny──→ Action blocked, evidence logged
   │         │──confirm→ Requires human confirmation
   └────┬────┘
        │ allow
          ▼
        PolicyEnforcedSurface
          │
          ▼
        Underlying Surface adapter
```

    **Key design point**: The policy engine is *enforceable*, not *advisory*. The normal execution path for future discovery and replay uses `PolicyEnforcedSurface`, a structural wrapper around the underlying `Surface`. UI-changing surface methods (`click`, `type`, `navigate`) must pass through `PolicyEngine.evaluate()` before execution. Passive operations (`observe`, `read`, `screenshot`, `currentUrl`, `isVisible`, `pageText`, `wait`, `close`) remain available without policy gating at this layer.

    `PolicyEngine` is deterministic: it evaluates an action and supplied context against immutable policy configuration. It does not own mutable approval state.

### What the policy controls (Phase 0)

| Check | Description |
|-------|-------------|
| Allowed domains | Navigation restricted to allowlisted domains |
| Allowed routes | Optional URL path pattern restrictions |
| Allowed action types | Only permitted action types can execute |
| Risky action types | Flagged actions require confirmation |
| Action count limit | Maximum actions per run |

`allowedActions` and `riskyActions` are validated with the canonical `ActionTypeSchema`; invalid action strings are rejected by schema validation.

### Human approval and remembered authorization

Policy decisions and human approval responses are separate concepts.

Policy engine dispositions:
- `allow`
- `deny`
- `require_confirmation`

Human approval responses:
- `deny` — do not execute the pending action; do not persist remembered authorization.
- `allow_once` — execute the current pending action only; do not persist remembered authorization.
- `allow_and_remember` — execute the current pending action and create durable remembered authorization.

`ApprovalStore` represents durable remembered authorization state only. It is separate from `PolicyEngine`; the policy engine does not read or mutate it. For Phase 0.5, only an in-memory store exists for tests and future integration. Future human approval code is the authority that will write `allow_and_remember` records. The LLM must not be given a conceptual API to write approval state directly.

Remembered approvals are explicitly scoped and optionally expirable. Scope supports:
- `tenant`
- `targetApp`
- `capabilityId`
- `actionType`
- `route`

A durable remembered approval must include `actionType` and at least one contextual boundary beyond action type. A scope containing only `actionType` is invalid because it would be a broad global approval. Matching is exact across supported scope fields, so an approval for one tenant/application/capability/action/route does not authorize another unless the stored scope explicitly matches that context. Expired approvals must not match.

### Future extensions
- PII redaction in evidence/artifacts
- Read-only vs. write distinction
- Per-artifact policy constraints
- Human confirmation for irreversible actions

### Approval evidence

Evidence events can represent approval-related concepts without requiring raw secrets:
- confirmation requested
- human denied
- human allowed once
- human allowed and remembered
- remembered approval applied

---

## 9. Human Handoff

> **Not implemented in Phase 0.** This section describes the intended state machine.

```
┌─────────────┐     stuck/risky     ┌────────────┐
│ AUTOMATION  │────────────────────→│  PAUSED    │
│ (agent runs)│                     │ (awaiting  │
└─────────────┘                     │  human)    │
       ▲                            └─────┬──────┘
       │                                  │
       │    human signals resume          │ human takes control
       │                                  ▼
       │                           ┌────────────┐
       └───────────────────────────│   HUMAN    │
                                   │ (operator  │
                                   │  controls) │
                                   └────────────┘
```

**Key design decisions**:
- The human operates the **same live session**, not a new one.
- The system preserves context across handoff (current step, observations, evidence).
- Human actions are recorded as evidence events with `controlMode: 'human'`.
- The `ControlMode` enum (`automation`, `human`, `paused`) is defined in the evidence model.

---

## 10. Multi-Tenant / Heterogeneous Design

> **Not implemented in Phase 0.** This section describes the design-level approach.

### The problem
Hundreds of tenants (financial institutions) each run ~20 applications. Many tenants run the **same vendor product** configured, branded, and versioned differently.

### Design approach

1. **Artifact parameterization**: Artifacts use typed input parameters and locator strategies rather than hardcoded values. The same artifact schema works for `memberId=10234` at Tenant A and `memberId=55001` at Tenant B.

2. **Tenant override key**: The `tenantOverrideKey` field on artifacts allows tenant-specific variations (different label text, slightly different page structure) to be expressed as overrides rather than full re-recordings.

3. **Surface-type abstraction**: The `surfaceType` field (`web`, `legacy-web`, `desktop`) allows the same conceptual capability to have different surface implementations. An artifact recorded against a web surface could be adapted for a desktop surface by re-recording against a `DesktopSurface` adapter without changing the domain model.

4. **Locator fallback chains**: Multiple locator strategies per target element mean that if Tenant A's app uses `aria-label="Member ID"` and Tenant B's uses a `<label>` tag, the fallback chain can accommodate both.

5. **Version tracking**: Semantic versioning on artifacts allows drift detection. When a replay fails because the target app changed, the artifact version is bumped and the failure is recorded as evidence.

---

## 11. Explicit Cuts (What Is NOT Yet Implemented)

| Component | Status |
|-----------|--------|
| LLM discovery agent loop | ✅ **Implemented** (Phase 1B-2) |
| BrowserSurface Playwright integration | ✅ **Implemented** (Phase 1A) |
| File-based evidence logging (JSONL) | ✅ **Implemented** (Phase 1B-2) |
| Artifact recording pipeline | ✅ **Implemented** (Phase 1D) |
| Deterministic replay executor | ✅ **Implemented** (Phase 1C) |
| Human operator console | **Not implemented** — state machine described, no UI |
| Human handoff mechanism | **Not implemented** — control mode types defined |
| PII redaction | **Not implemented** — design note only |
| Multi-tenant override resolution | **Not implemented** — field exists, no logic |
| Fault injection in target app | **Not implemented** — architecture supports it |
| Desktop surface adapter | **Not implemented** — interface supports it |

These will be implemented in subsequent phases.

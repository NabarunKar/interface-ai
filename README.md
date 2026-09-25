# Computer-Use Automation System

A capture-once, replay-many computer-use system for legacy back-office banking UIs. Built with TypeScript on Node, Playwright/Chromium as the live browser surface, Zod for domain and model validation, and an Express server-rendered "Bank Operations Console" (`apps/bank-ops/`) as the automation target.

**The model discovers the workflow once. The artifact becomes a reusable capability. Deterministic replay executes the capability in production with zero model calls.**

See [REPORT.md](./REPORT.md) for the complete engineering design report and trade-off analysis.
Walkthrough video: https://www.youtube.com/watch?v=RpwUyZOu-1E

---

## Quickstart & Reproducibility Path

### 1. Installation

```bash
npm install
npx playwright install chromium
```

### 2. Live LLM Discovery (Requires API Credentials)

Discovery uses a real multimodal LLM to explore the UI, reach the goal, independently verify page state, and synthesize a reusable capability artifact.

Configure credentials in `.env` (see `.env.example`):
```bash
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-3.8-flash

# Optional fallback provider:
TAMU_API_KEY=your_tamu_key
TAMU_BASE_URL=https://chat-api.tamu.ai/api
TAMU_MODEL=your_model
```

Run discovery (starts an ephemeral Bank Operations server automatically, or connects to `--url`):
```bash
npm run agent:discover -- \
  --goal "Find member 10234 and return their current savings balance" \
  --headed
```

The discovery CLI automatically loads `.env` if present, drives Chromium, verifies the balance on the live DOM, and writes the parameterized artifact to `evidence/artifacts/lookup-member-savings-balance.json`.

### 3. Deterministic Replay (Zero LLM / No API Credentials)

Replay executes the persisted artifact step-by-step with **no LLM in the loop**:

```bash
# Replay for member 10234 (extracts $8,920.14 in ~200ms):
npm run agent:replay -- \
  --artifact evidence/artifacts/lookup-member-savings-balance.json \
  --param memberId=10234

# Replay for a different member (proves artifact is a reusable capability, not a static recording):
npm run agent:replay -- \
  --artifact evidence/artifacts/lookup-member-savings-balance.json \
  --param memberId=10235

# Replay for a nonexistent member (returns expected business outcome, exit code 0):
npm run agent:replay -- \
  --artifact evidence/artifacts/lookup-member-savings-balance.json \
  --param memberId=99999
```

**Proving zero LLM dependency**: Replay succeeds even with all provider credentials completely removed from the environment:
```bash
env -u GEMINI_API_KEY -u TAMU_API_KEY npm run agent:replay -- \
  --artifact evidence/artifacts/lookup-member-savings-balance.json \
  --param memberId=10234
```

---

## Target Application

The Bank Operations Console is an internal server-rendered banking application:

```bash
npm run bank-ops
```
Access at [http://localhost:3100](http://localhost:3100). Test members: `10234` (Jane Doe, Savings: $8,920.14), `10235` (John Smith, Savings: $15,340.89), `99999` (nonexistent member).

---

## Architecture Overview

```
DISCOVERY (LLM present)
  Goal → DiscoveryAgent (observe → decide → validate → policy → execute)
       → ModelClient (Gemini primary, TAMU fallback) → ModelDecision (Zod)
       → PolicyEnforcedSurface → BrowserSurface (Playwright) → Bank Ops Console
       → GoalVerifier (independent DONE check) → ArtifactRecorder → evidence/artifacts/*.json

REPLAY (LLM absent)
  CapabilityArtifact + params → Pre-flight Validation & Interpolation
       → ReplayEngine (strict ordered execution, no planning)
       → PolicyEnforcedSurface → BrowserSurface → Bank Ops Console
       → ReplayResult + JSONL evidence
```

- **Surface Abstraction**: Technology-neutral contract exposing an immutable `sessionId`. Domain types, policies, and handoff never import Playwright handles.
- **Provider Architecture**: Behind a technology-neutral `ModelClient` interface. `FallbackModelClient` routes transient availability failures (429/500/502/503/504, timeouts) to TAMU AI Chat, while client errors (400/401/403) fail fast.
- **Independent Verification**: A model's `DONE` claim is never trusted. `GoalVerifier` independently verifies live DOM state before an artifact is recorded.
- **Artifact Parameterization**: Replaces concrete values with `{{paramName}}` substitutions. Artifacts define inputs, ordered steps, postconditions, output selectors, expected business outcomes, and policy constraints.

---

## Safety & Policy Enforcement

- **Policy Boundary**: `PolicyEnforcedSurface` intercepts mutating actions (`click`, `type`, `navigate`) and evaluates them via `PolicyEngine` against allowed domains, action allowlists, and risky target rules. Passive reads pass through.
- **Model Trust Boundary**: Model outputs arrive as untrusted `unknown` types and are strictly parsed through Zod before reaching any surface call. The model never receives shell or browser handles.
- **Result Taxonomy**: Callers receive explicit structured outcomes: `success`, `business_outcome` (e.g. `MEMBER_NOT_FOUND`, exit 0), `denied` (human refusal), `invalid_input`, `invalid_artifact`, `recoverable_failure`, and `hard_failure`.

---

## Human Handoff & Same-Session Escalation

When policy encounters an action requiring confirmation (e.g., clicking `[ Reset Web Access Password ]`), automation pauses and delegates to `HandoffCoordinator`:
- **`allow_once`**: Stages a single-use authorization token consumed strictly once on retry through policy evaluation.
- **`allow_and_remember`**: Saves a scoped, expirable record in `ApprovalStore` for exact matching contexts.
- **`deny`**: Replay halts with terminal outcome `status: "denied"` / `category: "HUMAN_DENIAL"`. The protected action never executes.
- **Same-Session Preservation**: Integration tests (`tests/same-session-handoff-integration.test.ts`) verify that the active `sessionId` and Playwright `Page` reference (`Object.is`) remain strictly identical before, during, and after handoff. No second browser, context, or tab is created.

*Scope note*: Live same-session handoff is wired into **replay**. Discovery currently treats confirmation boundaries as terminal `needs_human` conditions.

---

## Automated Verification

```bash
# Run the full automated test suite (unit, contract, policy, replay, and browser integration):
npm test

# Run TypeScript type check:
npx tsc --noEmit

# Run only same-session handoff integration tests:
npx vitest run tests/same-session-handoff-integration.test.ts
```

---

## Evidence & Audit Trail

Audit evidence is committed directly in the repository to demonstrate real executions:
- **`evidence/artifacts/`**: Persisted, schema-validated capability artifacts (`lookup-member-savings-balance.json`).
- **`evidence/discovery/`**: Canonical discovery run (`run-1789776107643.jsonl`, `result-1789776140770.json`) and real-world fallback error capture (`run-1789775851115.jsonl`, `result-1789775862122.json`).
- **`evidence/replay/`**: Deterministic replay logs for successful balance extraction (`replay-success-10234.jsonl`) and business outcomes (`replay-member-not-found-99999.jsonl`).
- Transient local test runs (`evidence/runs/`, `evidence/replays/`) are ignored by `.gitignore`.

---

## Project Structure

```
├── apps/
│   └── bank-ops/               # Target Express banking application & fixture data
├── src/
│   ├── agent/                  # Discovery agent, model clients (Gemini/TAMU), goal verifiers
│   ├── domain/                 # Core Zod schemas (actions, goals, artifacts, outcomes, policy)
│   ├── surface/                # Technology-neutral Surface interface & Playwright BrowserSurface
│   ├── policy/                 # PolicyEngine, PolicyEnforcedSurface wrapper, ApprovalStore
│   ├── handoff/                # HandoffCoordinator, state machine, same-session contracts
│   ├── replay/                 # Deterministic ReplayEngine (zero LLM in the loop)
│   ├── artifact/               # ArtifactRecorder & parameterization logic
│   ├── interpolation/          # {{param}} template interpolation
│   └── evidence/               # FileEvidenceLogger (JSONL) & InMemoryEvidenceLogger
├── scripts/
│   ├── discover.ts             # Live LLM discovery CLI (npm run agent:discover)
│   ├── replay.ts               # Deterministic replay CLI (npm run agent:replay)
│   └── browser-surface-smoke.ts# BrowserSurface smoke test
├── tests/                      # Automated Vitest test suites
├── evidence/                   # Committed discovery traces, replay logs, and artifacts
├── REPORT.md                   # Complete architectural design report & trade-off analysis
├── PROJECT_SPEC.md             # Detailed engineering specification
└── README.md
```

---

## Deliberate Scope Limitations

To keep the core loop authentic and production-verified, the following capabilities are deliberately not implemented in this prototype:
- **Generic PII redaction**: Credentials and API keys are scrubbed, and observations capture bounding metrics rather than raw DOM; however, there is no automatic PII masking engine for member data. (See [REPORT.md](./REPORT.md#line=83) for a production design).
- **Non-web surface adapters**: The technology-neutral `Surface` interface supports web and future desktop/terminal adapters, but only Playwright/Chromium is implemented.
- **Production operator UI**: Handoff features an in-process callback and verified state machine, not a web-based human operator dashboard.
- **Multi-tenant infrastructure**: Scoped approval keys and runtime entry-point overrides exist, but per-tenant isolation catalogs and configuration services are not implemented.
- **Automatic replay recovery**: `recoverable_failure` indicates a transient failure the caller may retry; the engine does not perform autonomous self-healing.

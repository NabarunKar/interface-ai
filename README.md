# Computer-Use Automation System

A computer-use automation system that enables AI agents to operate legacy back-office applications by driving their UI — observing the screen, clicking, typing, and navigating — the way a human operator would.

**The model discovers. The artifact becomes a reusable capability. Deterministic replay is how the capability is invoked in production.**

## Architecture Overview

```
Goal
  ↓
DiscoveryAgent (observe → decide → validate → policy → execute → loop)
  ↓
ModelClient (interface)
  ↓
FallbackModelClient
  ├── GeminiModelClient (primary: @google/genai, gemini-3.8-flash)
  └── TamuModelClient (fallback: OpenAI-compatible chat completions)
  ↓
ModelDecision (validated via Zod)
  ↓
PolicyEnforcedSurface (enforces domain/action allowlists)
  ↓
BrowserSurface (Playwright)
  ↓
Target Application (Bank Operations Console)
```

See [PROJECT_SPEC.md](./PROJECT_SPEC.md) for the full architectural specification.

## Prerequisites

- **Node.js** ≥ 18
- **npm** ≥ 9
- **Playwright Chromium**: `npx playwright install chromium`
- **LLM Credentials** (for live discovery runs only):
  - Primary (Gemini): `GEMINI_API_KEY` (and optional `GEMINI_MODEL`, default: `gemini-3.8-flash`)
  - Fallback (TAMU): `TAMU_API_KEY`, `TAMU_BASE_URL`, `TAMU_MODEL` (supplied by developer)

## Installation

```bash
npm install
npx playwright install chromium
```

## Running the Target Application

The Bank Operations Console is a local server-rendered web app used as the automation target:

```bash
npm run bank-ops
```

Then open [http://localhost:3100](http://localhost:3100) in your browser.

**Available workflows:**
- Search for a member by ID (try: `10234`, `10235`, `99999`)
- View member information
- View account balances

## Running Tests

```bash
npm test
```

This runs all tests via Vitest, covering:
- Target application routes and responses
- Domain schema validation (Zod)
- Policy engine allow/deny decisions
- Evidence logger functionality
- BrowserSurface integration via Playwright/Chromium
- Agent contract validation (ModelDecision, AgentResult, state machine)
- **Discovery agent loop** — 14 deterministic tests using FakeModelClient against real browser + real bank-ops

```bash
npx tsc --noEmit    # type-check without emitting
```

Run only the discovery agent tests:

```bash
npm test -- tests/discovery-agent.test.ts
```

## Live Discovery Run

The discovery agent uses a real LLM to genuinely operate the Bank Operations Console.

### Provider Architecture & Fallback Semantics

The discovery agent interacts solely with the provider-neutral `ModelClient` interface. Provider adapters and fallback are decoupled from the agent core:

```
DiscoveryAgent
    ↓
ModelClient (interface)
    ↓
FallbackModelClient
    ├── GeminiModelClient (primary: @google/genai, gemini-3.8-flash)
    └── TamuModelClient (fallback: OpenAI-compatible chat completions)
```

- **Gemini (`GeminiModelClient`)**: Primary provider using `@google/genai` with default model `gemini-3.8-flash`.
- **TAMU AI Chat (`TamuModelClient`)**: Fallback provider using an OpenAI-compatible `/chat/completions` endpoint with JSON mode.
- **Fallback Policy (`FallbackModelClient`)**:
  - Automatically falls back to TAMU on **transient provider availability failures**: HTTP 429, 500, 502, 503, 504, network timeouts, connection resets/refusals.
  - **Does NOT fall back** on non-transient configuration or client errors: HTTP 400, 401, 403, 404, 422, invalid request schema, or missing credentials. These fail fast to expose actionable configuration errors.
  - If TAMU is not configured in the environment, the system runs with Gemini alone. If Gemini fails and TAMU is unconfigured, Gemini's error is reported directly without searching external locations.

### Configuration

Set credentials and provider selections via environment variables (or repository `.env`):

```bash
# Gemini Provider (Primary)
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.8-flash

# TAMU AI Chat Provider (Fallback - supplied by developer)
TAMU_API_KEY=
TAMU_BASE_URL=
TAMU_MODEL=

# Provider Selection (optional overrides)
LLM_PRIMARY_PROVIDER=gemini
LLM_FALLBACK_PROVIDER=tamu
```

> **Note**: Do not commit real credentials. `TAMU_BASE_URL` and `TAMU_MODEL` are deployment-specific and must be provided by the developer.

### Running Discovery

```bash
# Run with configured environment variables:
npm run agent:discover -- \
  --goal "Find member 10234 and return their current savings balance"
```

By default, the CLI starts an ephemeral Bank Operations server on a random port and tears it down when done. Use `--url` to override with an already-running instance:

```bash
npm run bank-ops &   # start server
npm run agent:discover -- --goal "..." --url http://localhost:3100
```

Options:
- `--goal "<text>"` — the natural-language goal (required)
- `--url <url>` — use an existing server instead of starting one
- `--headed` — show the browser window during the run
- `--maxSteps <n>` — maximum action steps (default: 15)
- `--provider <gemini|tamu>` — explicitly force a single provider (bypasses fallback)
- `--model <name>` — override the model name for the selected provider

The run prints a structured `AgentResult` and saves evidence to `evidence/discovery/`.

## Deterministic Replay

Replay a persisted capability artifact **without any LLM or API credentials**:

```bash
npm run agent:replay -- \
  --artifact evidence/artifacts/lookup-member-savings-balance.json \
  --param memberId=10234
```

The replay CLI starts an ephemeral Bank Operations server, loads and validates the artifact, replays it step-by-step through the existing ReplayEngine, and prints the structured result.

### Business Outcome Example

```bash
npm run agent:replay -- \
  --artifact evidence/artifacts/lookup-member-savings-balance.json \
  --param memberId=99999
```

Returns `status: "business_outcome"` with `code: "MEMBER_NOT_FOUND"` — a legitimate answer, not a failure.

### Options

- `--artifact <path>` — path to a persisted CapabilityArtifact JSON (required)
- `--param key=value` — invocation parameter (repeatable for multiple params)
- `--url <url>` — use an existing server instead of starting an ephemeral one
- `--headed` — show the browser window during replay

### Exit Codes

- `0` — success or expected business outcome
- `1` — replay failure, invalid artifact, or invalid input

### Demo Path (Discovery → Replay)

```bash
# 1. Discovery (requires API keys):
npm run agent:discover -- --goal "Find member 10234 and return their current savings balance"

# 2. Replay the resulting artifact (no API keys needed):
npm run agent:replay -- \
  --artifact evidence/artifacts/lookup-member-savings-balance.json \
  --param memberId=10234

# 3. Replay with a different member (no API keys needed):
npm run agent:replay -- \
  --artifact evidence/artifacts/lookup-member-savings-balance.json \
  --param memberId=10235
```

## BrowserSurface Headed Smoke Test

```bash
npm run bank-ops &
npm run browser-surface:smoke -- http://localhost:3100
```

## Project Structure

```
├── apps/
│   └── bank-ops/               # Target banking application
│       └── src/
│           ├── server.ts            # Express server
│           ├── templates.ts         # Server-rendered HTML
│           └── data/
│               └── members.ts       # Deterministic fixture data
├── src/
│   ├── agent/                  # Agent layer
│   │   ├── types.ts                # ModelClient, ModelDecision, AgentResult, state machine
│   │   ├── validation.ts           # parseModelDecision, buildModelInput
│   │   ├── fake-model.ts           # Deterministic FakeModelClient for tests
│   │   ├── discovery-agent.ts      # Core discovery loop
│   │   ├── gemini-model.ts         # Gemini adapter (primary provider)
│   │   ├── tamu-model.ts           # TAMU AI Chat adapter (OpenAI-compatible fallback)
│   │   ├── fallback-model.ts       # FallbackModelClient with transient error handling
│   │   ├── provider-error.ts       # Provider error taxonomy and classification
│   │   ├── provider-factory.ts     # Provider resolution and fallback construction
│   │   ├── prompt-utils.ts         # Shared provider-neutral prompt rendering
│   │   ├── system-prompt.ts        # LLM system prompt
│   │   └── goal-verifier.ts        # Independent DONE verification
│   ├── domain/                 # Core types & Zod schemas
│   │   ├── action.ts               # Actions, locators, target strategies
│   │   ├── goal.ts                 # Goal representation
│   │   ├── observation.ts          # Surface observations
│   │   ├── outcome.ts              # Replay results, error taxonomy
│   │   ├── artifact.ts             # Capability artifact schema
│   │   ├── policy.ts               # Policy config & decision types
│   │   ├── evidence.ts             # Evidence event model
│   │   └── approval.ts             # Approval decisions and scoped records
│   ├── surface/                # Surface abstraction layer
│   │   ├── types.ts                # Technology-neutral Surface interface
│   │   └── browser-surface.ts      # Playwright adapter
│   ├── policy/                 # Policy enforcement
│   │   ├── engine.ts               # Configurable local policy engine
│   │   ├── enforced-surface.ts     # PolicyEnforcedSurface wrapper
│   │   └── approval-store.ts       # Remembered approval store
│   ├── evidence/               # Evidence/event logging
│   │   ├── logger.ts               # In-memory evidence logger
│   │   └── file-logger.ts          # JSONL file-based logger
│   ├── artifact/               # Artifact recording & persistence
│   │   ├── types.ts                # Recording options & step records
│   │   ├── recorder.ts             # ArtifactRecorder component
│   │   └── index.ts
│   ├── handoff/                # Human handoff & escalation
│   │   ├── types.ts                # HumanHandoff contract, HandoffResolution
│   │   ├── state-machine.ts        # Explicit deterministic lifecycle
│   │   ├── coordinator.ts          # HandoffCoordinator
│   │   └── index.ts
│   ├── replay/                 # Deterministic replay layer
│   │   ├── types.ts                # ReplayOptions
│   │   ├── checkpoint-evaluator.ts # Checkpoint condition evaluation on Surface
│   │   ├── replay-engine.ts        # Deterministic step executor (no LLM)
│   │   └── index.ts
│   └── interpolation/          # Artifact parameter interpolation
│       └── interpolate.ts
├── scripts/
│   ├── browser-surface-smoke.ts    # Headed browser smoke test
│   └── discover.ts                 # Live discovery agent CLI with fallback support
├── tests/                      # Vitest test suites (205 tests)
│   └── fixtures/                   # Canonical capability artifact fixtures
├── evidence/                   # Discovery run evidence and artifacts (gitignored)
│   ├── discovery/                  # Run event logs (JSONL)
│   └── artifacts/                  # Persisted CapabilityArtifacts (JSON)
├── PROJECT_SPEC.md             # Architectural specification
└── README.md
```

## Human Handoff & Same-Session Escalation (Phase 1E)

When automation encounters an action requiring confirmation (such as a high-risk credential reset or protected transaction), the system safely pauses automation and escalates control to a human operator.

### 1. Why Human Escalation Exists
Automation should never guess on high-consequence operations or perform unconfirmed side effects. Instead of failing blindly or crashing, the system establishes a clean confirmation boundary, captures sanitized context, and transfers operational control to a human.

### 2. Same-Session Preservation
Human escalation occurs on the **exact same live Surface/session**:
- The technology-neutral `Surface` maintains a stable, immutable `sessionId`.
- The human operator receives the active `Surface` reference—no browser is closed, no second browser is launched, and no detached session is created.
- Continuity is verified by asserting that `sessionId` and underlying page references are identical before, during, and after handoff.

### 3. Approval Flow Through Policy Boundary
Human approval does **NOT** bypass policy enforcement:
```
Action Proposed
  ↓
PolicyEngine evaluates
  ↓
Returns `require_confirmation`
  ↓
Automation pauses; HumanHandoff created
  ↓
Human operator resolves:
  ├── allow_once: stages single-use authorization on PolicyEnforcedSurface
  ├── allow_and_remember: saves scoped record to ApprovalStore
  └── deny: records denial; workflow terminates without executing action
  ↓
Action retried through PolicyEnforcedSurface
  ↓
PolicyEngine re-evaluates (NEVER bypassed)
  ↓
Ephemeral or remembered approval matches scope and permits execution
  ↓
Action executes on live surface; automation resumes
```

### 4. Structured Evidence Audit Trail
Structured JSONL evidence events capture every transition:
- `handoff_requested`: Automation paused (`controlMode: 'paused'`), recording blocked action, reason, and `sessionId`.
- `human_takeover`: Human assumed control (`controlMode: 'human'`).
- `approval_granted` / `approval_denied`: Operator decision and reasoning recorded.
- `human_returned`: Control returned to automation.
- `session_resumed`: Automation resumed on the live session (`controlMode: 'automation'`).

## What's Implemented

- ✅ Documented architecture and technology choices
- ✅ Local banking back-office target application
- ✅ Surface abstraction interface (technology-neutral with stable `sessionId`)
- ✅ Playwright-backed BrowserSurface for real Chromium browser interaction
- ✅ Domain types with Zod validation (goals, actions, observations, artifacts, outcomes, evidence)
- ✅ Policy engine with domain/action/route/target allowlisting and regex-validated `riskyRoutes`
- ✅ Policy-enforced surface wrapper with ephemeral `allow_once` and durable `allow_and_remember` approval handling
- ✅ Deterministic interpolation helpers and artifact validation
- ✅ Evidence event model
- ✅ Provider-neutral agent contracts (ModelClient, ModelDecision, AgentResult, state machine)
- ✅ **Primary LLM provider**: Gemini 3.8 Flash via `@google/genai`
- ✅ **Fallback LLM provider**: TAMU AI Chat (OpenAI-compatible chat completions)
- ✅ **Provider fallback wrapper**: `FallbackModelClient` with selective transient failure routing (429, 500, 502, 503, 504, timeout, network error)
- ✅ **Fast fail on client/auth errors**: 400, 401, 403, and invalid configs fail immediately without hiding configuration issues
- ✅ **Discovery loop** (observe → decide → validate → policy → execute)
- ✅ **Structured JSON output** from model (schema-constrained, not text-parsed)
- ✅ **Independent DONE verification** (model claims ≠ system success)
- ✅ **Model trust boundary** (all model output validated via Zod before reaching surface)
- ✅ **File-based evidence logging** (JSONL)
- ✅ **Deterministic agent & fallback tests** (205 tests across 16 test files)
- ✅ **CLI for live discovery** (`npm run agent:discover`) with provider fallback and override flags
- ✅ **Deterministic replay engine** (`src/replay/`): executes capability artifacts step-by-step with **zero LLM in the loop**
- ✅ **Runtime entry point flexibility**: replay against ephemeral test environments without mutating artifact provenance
- ✅ **Checkpoint evaluation**: pre/postconditions, success conditions, and business outcomes (`MEMBER_NOT_FOUND`)
- ✅ **Granular replay taxonomy**: `success`, `business_outcome`, `denied` (human control decision), `invalid_artifact`, `invalid_input`, `recoverable_failure`, `hard_failure`
- ✅ **Live replay integration tests**: end-to-end replay verified against local Bank Operations Console in real Chromium
- ✅ **Artifact recording & persistence** (`src/artifact/`): converts live discovery traces into reusable, validated `CapabilityArtifact` JSON files
- ✅ **Parameterization**: abstracts concrete inputs (e.g. `10234`) into `{{memberId}}` using the existing interpolation contract
- ✅ **Full discovery → artifact → replay lifecycle**: verified end-to-end against live Bank Operations Console
- ✅ **Human handoff & same-session escalation** (`src/handoff/`): technology-neutral handoff, deterministic state machine, approval integration through policy boundary, and strict session identity verification

## What's NOT Implemented Yet

- ❌ PII redaction


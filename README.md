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
├── tests/                      # Vitest test suites (176 tests)
│   └── fixtures/                   # Canonical capability artifact fixtures
├── evidence/                   # Discovery run evidence (gitignored)
├── PROJECT_SPEC.md             # Architectural specification
└── README.md
```

## What's Implemented

- ✅ Documented architecture and technology choices
- ✅ Local banking back-office target application
- ✅ Surface abstraction interface (technology-neutral)
- ✅ Playwright-backed BrowserSurface for real Chromium browser interaction
- ✅ Domain types with Zod validation (goals, actions, observations, artifacts, outcomes, evidence)
- ✅ Policy engine with domain/action/route allowlisting
- ✅ Policy-enforced surface wrapper and approval model
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
- ✅ **Deterministic agent & fallback tests** (176 tests, zero live API calls in tests)
- ✅ **CLI for live discovery** (`npm run agent:discover`) with provider fallback and override flags
- ✅ **Deterministic replay engine** (`src/replay/`): executes capability artifacts step-by-step with **zero LLM in the loop**
- ✅ **Runtime entry point flexibility**: replay against ephemeral test environments without mutating artifact provenance
- ✅ **Checkpoint evaluation**: pre/postconditions, success conditions, and business outcomes (`MEMBER_NOT_FOUND`)
- ✅ **Granular replay taxonomy**: `success`, `business_outcome`, `invalid_artifact`, `invalid_input`, `recoverable_failure`, `hard_failure`
- ✅ **Live replay integration tests**: end-to-end replay verified against local Bank Operations Console in real Chromium

## What's NOT Implemented Yet

- ❌ Artifact recording pipeline
- ❌ Human operator console / handoff
- ❌ PII redaction

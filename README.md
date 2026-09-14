# Computer-Use Automation System

A computer-use automation system that enables AI agents to operate legacy back-office applications by driving their UI — observing the screen, clicking, typing, and navigating — the way a human operator would.

**The model discovers. The artifact becomes a reusable capability. Deterministic replay is how the capability is invoked in production.**

> ⚠️ This project is being implemented incrementally. Phase 0 (foundation) is complete. The LLM discovery agent, artifact recorder, replay executor, and human handoff are not yet implemented.

## Architecture Overview

```
Agent Layer (Phase 1)
        ↓
Policy Engine ← enforces allowlists, blocks unsafe actions
        ↓
Surface Interface ← technology-neutral (observe, click, type, read, navigate)
        ↓
Surface Adapter ← BrowserSurface (Playwright), future: Desktop, LegacyWeb
        ↓
Target Application ← Bank Operations Console
```

See [PROJECT_SPEC.md](./PROJECT_SPEC.md) for the full architectural specification.

## Prerequisites

- **Node.js** ≥ 18
- **npm** ≥ 9

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
- BrowserSurface integration against the local Bank Operations Console via Playwright/Chromium

Run only the browser surface integration tests:

```bash
npm test -- tests/browser-surface.test.ts
```

## BrowserSurface Headed Smoke Test

Start the Bank Operations Console in one terminal:

```bash
npm run bank-ops
```

Then launch a headed BrowserSurface smoke test in another terminal:

```bash
npm run browser-surface:smoke -- http://localhost:3100
```

This opens Chromium through the `Surface` abstraction and prints the normalized observation. It does not run an LLM agent or replay executor.

## Project Structure

```
├── apps/
│   └── bank-ops/           # Target banking application
│       └── src/
│           ├── server.ts        # Express server
│           ├── templates.ts     # Server-rendered HTML
│           └── data/
│               └── members.ts   # Deterministic fixture data
├── src/
│   ├── domain/              # Core types & Zod schemas
│   │   ├── action.ts            # Actions, locators, target strategies
│   │   ├── goal.ts              # Goal representation
│   │   ├── observation.ts       # Surface observations
│   │   ├── outcome.ts           # Replay results, error taxonomy
│   │   ├── artifact.ts          # Capability artifact schema
│   │   ├── policy.ts            # Policy config & decision types
│   │   └── evidence.ts         # Evidence event model
│   ├── surface/             # Surface abstraction layer
│   │   ├── types.ts             # Technology-neutral Surface interface
│   │   └── browser-surface.ts   # Playwright adapter (Phase 1)
│   ├── policy/              # Policy enforcement engine
│   │   └── engine.ts            # Configurable local policy
│   └── evidence/            # Evidence/event logging
│       └── logger.ts            # In-memory evidence logger
├── tests/                   # Vitest test suites
├── evidence/                # Discovery/replay run evidence (future)
├── PROJECT_SPEC.md          # Architectural specification (source of truth)
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
- ✅ Test suite

## What's NOT Implemented Yet

- ❌ LLM discovery agent loop
- ❌ Artifact recording pipeline
- ❌ Deterministic replay executor
- ❌ Human operator console / handoff
- ❌ PII redaction
- ❌ File-based evidence logging

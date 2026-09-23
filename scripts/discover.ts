/**
 * Discovery agent CLI.
 *
 * Runs the real LLM discovery agent against the Bank Operations Console.
 *
 * Usage:
 *   npm run agent:discover -- --goal "Find member 10234 and return their current savings balance"
 *   npm run agent:discover -- --goal "..." --url http://localhost:3100
 *   npm run agent:discover -- --goal "..." --headed
 *
 * By default, starts an ephemeral Bank Operations server on a random port
 * and tears it down when the run completes. Use --url to override with
 * an already-running instance.
 */

import { createServer, type Server } from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../apps/bank-ops/src/server.js';
import { BrowserSurface } from '../src/surface/browser-surface.js';
import { LocalPolicyEngine } from '../src/policy/engine.js';
import { PolicyEnforcedSurface } from '../src/policy/enforced-surface.js';
import { DiscoveryAgent } from '../src/agent/discovery-agent.js';
import { createConfiguredModelClient } from '../src/agent/index.js';
import { MemberBalanceVerifier } from '../src/agent/goal-verifier.js';
import { FileEvidenceLogger } from '../src/evidence/file-logger.js';
import { ArtifactRecorder } from '../src/artifact/index.js';
import type { Goal } from '../src/domain/goal.js';

// ---------------------------------------------------------------------------
// Environment setup
// ---------------------------------------------------------------------------

// Automatically load local .env if present (built into Node.js 20.12+)
try {
  process.loadEnvFile?.();
} catch {
  // Silently ignore if .env does not exist (e.g. CI or container environments)
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

const goalText = getArg('goal');
const urlOverride = getArg('url');
const modelOverride = getArg('model');
const providerOverride = getArg('provider');
const headed = args.includes('--headed');
const maxSteps = getArg('maxSteps') ? parseInt(getArg('maxSteps')!, 10) : 15;

if (!goalText) {
  console.error('Usage: npm run agent:discover -- --goal "<goal text>" [--url <url>] [--provider <gemini|tamu>] [--model <model>] [--headed] [--maxSteps <n>]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

async function startEphemeralServer(): Promise<{ server: Server; url: string }> {
  const app = createApp();
  return new Promise((resolveP) => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const url = `http://127.0.0.1:${port}`;
      console.log(`[discover] Ephemeral Bank Operations Console started at ${url}`);
      resolveP({ server, url });
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let server: Server | undefined;
  let entryPoint: string;

  if (urlOverride) {
    entryPoint = urlOverride;
    console.log(`[discover] Using existing server at ${entryPoint}`);
  } else {
    const result = await startEphemeralServer();
    server = result.server;
    entryPoint = result.url;
  }

  // Evidence setup
  const evidenceDir = resolve(process.cwd(), 'evidence', 'discovery');
  mkdirSync(evidenceDir, { recursive: true });
  const evidencePath = resolve(evidenceDir, `run-${Date.now()}.jsonl`);
  const evidence = new FileEvidenceLogger(evidencePath);

  // Model client (with automatic fallback if configured)
  const model = createConfiguredModelClient({
    primaryProvider: providerOverride,
    geminiModel: modelOverride,
    tamuModel: modelOverride,
  });

  // Browser surface
  const surface = await BrowserSurface.create({ headless: !headed });

  // Policy
  const hostname = new URL(entryPoint).hostname;
  const policy = new LocalPolicyEngine({
    allowedDomains: [hostname, 'localhost', '127.0.0.1'],
    allowedActions: ['navigate', 'click', 'type', 'read', 'wait', 'screenshot'],
  });

  // Enforcement wrapper
  const enforcedSurface = new PolicyEnforcedSurface(surface, policy, undefined, () => ({
    currentUrl: entryPoint,
    targetApp: 'bank-ops',
  }));

  // Goal
  const goal: Goal = {
    id: `goal-${Date.now()}`,
    description: goalText,
    targetApp: 'bank-ops',
    entryPoint,
    maxSteps,
  };

  // Verifier
  const verifier = new MemberBalanceVerifier();

  // Artifact recorder
  const artifactsDir = resolve(process.cwd(), 'evidence', 'artifacts');
  const recorder = new ArtifactRecorder({
    outputDir: artifactsDir,
    canonicalEntryPoint: urlOverride ?? 'http://localhost:3100/',
  });

  // Agent
  const agent = new DiscoveryAgent(model, enforcedSurface, evidence, verifier, {
    maxSteps,
    timeoutMs: 120_000,
    recorder,
  });

  console.log(`[discover] Goal: ${goalText}`);
  console.log(`[discover] Model: ${model.modelName}`);
  console.log(`[discover] Max steps: ${maxSteps}`);
  console.log(`[discover] Headed: ${headed}`);
  console.log(`[discover] Evidence: ${evidencePath}`);
  console.log(`[discover] Starting discovery run...\n`);

  try {
    const result = await agent.run(goal);

    console.log('\n[discover] ========== RESULT ==========');
    console.log(JSON.stringify(result, null, 2));
    console.log('[discover] ============================\n');

    // Save structured result alongside evidence
    const resultPath = resolve(evidenceDir, `result-${Date.now()}.json`);
    writeFileSync(resultPath, JSON.stringify(result, null, 2));
    console.log(`[discover] Result saved to: ${resultPath}`);
    console.log(`[discover] Evidence saved to: ${evidencePath}`);
    if (result.artifactPath) {
      console.log(`[discover] Artifact saved to: ${result.artifactPath}`);
    }

    process.exitCode = result.status === 'success' ? 0 : 1;
  } catch (error) {
    console.error('[discover] Fatal error:', error);
    process.exitCode = 1;
  } finally {
    await surface.close();
    if (server) {
      server.close();
      console.log('[discover] Ephemeral server stopped');
    }
  }
}

main();

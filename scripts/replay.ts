/**
 * Deterministic replay CLI.
 *
 * Replays a persisted CapabilityArtifact against the Bank Operations Console
 * with ZERO LLM/API involvement. No ModelClient, no Gemini, no TAMU, no API keys.
 *
 * Usage:
 *   npm run agent:replay -- --artifact evidence/artifacts/lookup-member-savings-balance.json --param memberId=10234
 *   npm run agent:replay -- --artifact evidence/artifacts/lookup-member-savings-balance.json --param memberId=99999
 *   npm run agent:replay -- --artifact <path> --param key=value --url http://localhost:3100
 *   npm run agent:replay -- --artifact <path> --param key=value --headed
 *
 * By default, starts an ephemeral Bank Operations server on a random port
 * and tears it down when the run completes. Use --url to override with
 * an already-running instance.
 */

import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../apps/bank-ops/src/server.js';
import { BrowserSurface } from '../src/surface/browser-surface.js';
import { LocalPolicyEngine } from '../src/policy/engine.js';
import { PolicyEnforcedSurface } from '../src/policy/enforced-surface.js';
import { ReplayEngine } from '../src/replay/index.js';
import { CapabilityArtifactSchema } from '../src/domain/artifact.js';
import { FileEvidenceLogger } from '../src/evidence/file-logger.js';
import { mkdirSync } from 'node:fs';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

/**
 * Parse all --param key=value arguments into a Record.
 */
export function parseParams(argv: string[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--param' && i + 1 < argv.length) {
      const raw = argv[i + 1];
      const eqIdx = raw.indexOf('=');
      if (eqIdx <= 0) {
        console.error(`Invalid --param format: '${raw}'. Expected key=value`);
        process.exit(1);
      }
      const key = raw.slice(0, eqIdx);
      const value = raw.slice(eqIdx + 1);
      params[key] = value;
    }
  }
  return params;
}

/**
 * Load and validate a CapabilityArtifact from a JSON file path.
 */
export function loadArtifact(filePath: string) {
  const absPath = resolve(process.cwd(), filePath);
  let raw: string;
  try {
    raw = readFileSync(absPath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read artifact file '${absPath}': ${msg}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Artifact file is not valid JSON: ${absPath}`);
  }

  const validated = CapabilityArtifactSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`Invalid CapabilityArtifact: ${validated.error.message}`);
  }

  return validated.data;
}
// ---------------------------------------------------------------------------
// CLI entry point (guarded so exports are importable from tests)
// ---------------------------------------------------------------------------

export function isMain(argv1: string | undefined, importMetaUrl: string): boolean {
  if (!argv1) return false;
  try {
    const currentFilePath = fileURLToPath(importMetaUrl);
    const resolvedArgv = resolve(argv1);
    return (
      resolvedArgv === currentFilePath ||
      resolve(argv1 + '.ts') === currentFilePath ||
      resolvedArgv === resolve(currentFilePath)
    );
  } catch {
    return false;
  }
}

const isMainModule = isMain(process.argv[1], import.meta.url);

if (isMainModule) {
  const artifactPath = getArg('artifact');
  const urlOverride = getArg('url');
  const headed = args.includes('--headed');
  const params = parseParams(args);

  if (!artifactPath) {
    console.error(
      'Usage: npm run agent:replay -- --artifact <path> --param key=value [--url <url>] [--headed]',
    );
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // Server lifecycle
  // -------------------------------------------------------------------------

  async function startEphemeralServer(): Promise<{ server: Server; url: string }> {
    const app = createApp();
    return new Promise((resolveP) => {
      const server = createServer(app);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        const url = `http://127.0.0.1:${port}`;
        console.log(`[replay] Ephemeral Bank Operations Console started at ${url}`);
        resolveP({ server, url });
      });
    });
  }

  // -------------------------------------------------------------------------
  // Main
  // -------------------------------------------------------------------------

  async function main() {
    // 1. Load and validate artifact
    let artifact;
    try {
      artifact = loadArtifact(artifactPath!);
    } catch (err) {
      console.error(`[replay] ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    console.log(`[replay] Artifact: ${artifact.name} (${artifact.id})`);
    console.log(`[replay] Params: ${JSON.stringify(params)}`);

    // 2. Start or connect to target server
    let server: Server | undefined;
    let entryPoint: string;

    if (urlOverride) {
      entryPoint = urlOverride;
      console.log(`[replay] Using existing server at ${entryPoint}`);
    } else {
      const result = await startEphemeralServer();
      server = result.server;
      entryPoint = result.url;
    }

    // 3. Evidence setup
    const evidenceDir = resolve(process.cwd(), 'evidence', 'replays');
    mkdirSync(evidenceDir, { recursive: true });
    const evidencePath = resolve(evidenceDir, `replay-${Date.now()}.jsonl`);
    const evidence = new FileEvidenceLogger(evidencePath);

    // 4. Browser surface (NO LLM, NO API keys)
    const surface = await BrowserSurface.create({ headless: !headed });

    // 5. Policy enforcement
    const hostname = new URL(entryPoint).hostname;
    const policy = new LocalPolicyEngine({
      allowedDomains: [hostname, 'localhost', '127.0.0.1'],
      allowedActions: ['navigate', 'click', 'type', 'read', 'wait', 'screenshot'],
    });

    const enforcedSurface = new PolicyEnforcedSurface(surface, policy, undefined, () => ({
      currentUrl: entryPoint,
      isReplay: true,
      targetApp: artifact.targetApp,
    }));

    // 6. ReplayEngine — deterministic, zero LLM
    const replayEngine = new ReplayEngine(enforcedSurface, { evidence });

    console.log(`[replay] Headed: ${headed}`);
    console.log(`[replay] Evidence: ${evidencePath}`);
    console.log(`[replay] Starting deterministic replay...\n`);

    try {
      const result = await replayEngine.replay(artifact, params, { entryPoint });

      console.log('\n[replay] ========== RESULT ==========');
      console.log(JSON.stringify(result, null, 2));
      console.log('[replay] ============================\n');
      console.log(`[replay] Evidence saved to: ${evidencePath}`);

      // Exit 0 for success or expected business outcome, nonzero for failures
      if (result.status === 'success' || result.status === 'business_outcome') {
        process.exitCode = 0;
      } else {
        process.exitCode = 1;
      }
    } catch (error) {
      console.error('[replay] Fatal error:', error);
      process.exitCode = 1;
    } finally {
      await surface.close();
      if (server) {
        server.close();
        console.log('[replay] Ephemeral server stopped');
      }
    }
  }

  main();
}


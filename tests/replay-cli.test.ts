import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../apps/bank-ops/src/server.js';
import { BrowserSurface } from '../src/surface/browser-surface.js';
import { LocalPolicyEngine } from '../src/policy/engine.js';
import { PolicyEnforcedSurface } from '../src/policy/enforced-surface.js';
import { ReplayEngine } from '../src/replay/index.js';
import { InMemoryEvidenceLogger } from '../src/evidence/logger.js';
import { CapabilityArtifactSchema } from '../src/domain/artifact.js';
import { parseParams, loadArtifact, isMain } from '../scripts/replay.js';

// ---------------------------------------------------------------------------
// CLI argument parsing tests (no browser needed)
// ---------------------------------------------------------------------------

describe('Replay CLI: parseParams', () => {
  it('should parse a single --param key=value', () => {
    const result = parseParams(['--param', 'memberId=10234']);
    expect(result).toEqual({ memberId: '10234' });
  });

  it('should parse multiple --param arguments', () => {
    const result = parseParams([
      '--param', 'memberId=10234',
      '--param', 'accountType=savings',
      '--param', 'format=json',
    ]);
    expect(result).toEqual({
      memberId: '10234',
      accountType: 'savings',
      format: 'json',
    });
  });

  it('should handle values containing equals signs', () => {
    const result = parseParams(['--param', 'query=a=b=c']);
    expect(result).toEqual({ query: 'a=b=c' });
  });

  it('should return empty record when no --param arguments', () => {
    const result = parseParams(['--artifact', 'path.json', '--headed']);
    expect(result).toEqual({});
  });

  it('should override duplicate param keys with the last value', () => {
    const result = parseParams([
      '--param', 'memberId=10234',
      '--param', 'memberId=10235',
    ]);
    expect(result).toEqual({ memberId: '10235' });
  });
});

// ---------------------------------------------------------------------------
// Main-module detection tests (handles spaces in filesystem paths)
// ---------------------------------------------------------------------------

describe('Replay CLI: isMain detection', () => {
  it('should correctly detect main module when filesystem path contains spaces', () => {
    const fakeMetaUrl = 'file:///path/with%20spaces/scripts/replay.ts';
    const fakeArgv1 = '/path/with spaces/scripts/replay.ts';
    expect(isMain(fakeArgv1, fakeMetaUrl)).toBe(true);
  });

  it('should detect main module without .ts extension in argv', () => {
    const fakeMetaUrl = 'file:///path/with%20spaces/scripts/replay.ts';
    const fakeArgv1 = '/path/with spaces/scripts/replay';
    expect(isMain(fakeArgv1, fakeMetaUrl)).toBe(true);
  });

  it('should return false when imported from another file (e.g., test runner)', () => {
    const fakeMetaUrl = 'file:///path/with%20spaces/scripts/replay.ts';
    const testRunnerArgv1 = '/path/with spaces/node_modules/vitest/vitest.mjs';
    expect(isMain(testRunnerArgv1, fakeMetaUrl)).toBe(false);
  });

  it('should return false when argv1 is undefined', () => {
    const fakeMetaUrl = 'file:///path/with%20spaces/scripts/replay.ts';
    expect(isMain(undefined, fakeMetaUrl)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Artifact loading tests (no browser needed)
// ---------------------------------------------------------------------------

describe('Replay CLI: loadArtifact', () => {
  it('should load and validate the committed persisted artifact', () => {
    const artifactPath = resolve(
      process.cwd(),
      'evidence/artifacts/lookup-member-savings-balance.json',
    );
    expect(existsSync(artifactPath)).toBe(true);

    const artifact = loadArtifact(artifactPath);
    expect(artifact.id).toBe('lookup-member-savings-balance');
    expect(artifact.inputs).toHaveLength(1);
    expect(artifact.inputs[0].name).toBe('memberId');
    expect(artifact.steps.length).toBeGreaterThan(0);
  });

  it('should throw on non-existent file', () => {
    expect(() => loadArtifact('/nonexistent/path/artifact.json')).toThrow(
      'Failed to read artifact file',
    );
  });

  it('should throw on invalid JSON', () => {
    const tmpDir = resolve(process.cwd(), 'evidence', 'test-tmp');
    mkdirSync(tmpDir, { recursive: true });
    const tmpFile = resolve(tmpDir, 'bad.json');
    writeFileSync(tmpFile, 'not json at all', 'utf-8');

    try {
      expect(() => loadArtifact(tmpFile)).toThrow('not valid JSON');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should throw on valid JSON that fails schema validation', () => {
    const tmpDir = resolve(process.cwd(), 'evidence', 'test-tmp');
    mkdirSync(tmpDir, { recursive: true });
    const tmpFile = resolve(tmpDir, 'invalid-artifact.json');
    writeFileSync(tmpFile, JSON.stringify({ id: 'test', steps: [] }), 'utf-8');

    try {
      expect(() => loadArtifact(tmpFile)).toThrow('Invalid CapabilityArtifact');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Zero LLM/provider involvement verification
// ---------------------------------------------------------------------------

describe('Replay CLI: zero LLM/provider involvement', () => {
  it('should not import any LLM provider modules', () => {
    // Read the replay.ts source and verify it has no LLM provider imports
    const replaySource = readFileSync(
      resolve(process.cwd(), 'scripts/replay.ts'),
      'utf-8',
    );

    // Extract only import lines for precise verification
    const importLines = replaySource
      .split('\n')
      .filter((line) => line.trimStart().startsWith('import '));

    const importBlock = importLines.join('\n');

    // No LLM provider imports
    expect(importBlock).not.toContain('gemini-model');
    expect(importBlock).not.toContain('tamu-model');
    expect(importBlock).not.toContain('fallback-model');
    expect(importBlock).not.toContain('provider-factory');
    expect(importBlock).not.toContain('ModelClient');
    expect(importBlock).not.toContain('@google/genai');

    // No API key references in the entire source
    expect(replaySource).not.toContain('GEMINI_API_KEY');
    expect(replaySource).not.toContain('TAMU_API_KEY');
  });
});

// ---------------------------------------------------------------------------
// Live replay integration tests (browser + bank-ops server)
// ---------------------------------------------------------------------------

describe('Replay CLI: live replay integration', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = createServer(app);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        baseUrl = `http://127.0.0.1:${port}/`;
        resolve();
      });
    });
  });

  afterAll(() => {
    server?.close();
  });

  function makePolicy() {
    return new LocalPolicyEngine({
      allowedDomains: ['127.0.0.1', 'localhost'],
      allowedActions: ['navigate', 'click', 'type', 'read', 'wait', 'screenshot'],
    });
  }

  async function withSurface<T>(fn: (surface: PolicyEnforcedSurface) => Promise<T>): Promise<T> {
    const rawSurface = await BrowserSurface.create({ headless: true });
    const policy = makePolicy();
    const enforcedSurface = new PolicyEnforcedSurface(rawSurface, policy, undefined, () => ({
      currentUrl: baseUrl,
      isReplay: true,
      targetApp: 'bank-ops',
    }));
    try {
      return await fn(enforcedSurface);
    } finally {
      await rawSurface.close();
    }
  }

  it('should replay member savings balance successfully using loaded persisted artifact', async () => {
    const artifact = loadArtifact('evidence/artifacts/lookup-member-savings-balance.json');

    await withSurface(async (surface) => {
      const evidence = new InMemoryEvidenceLogger();
      const engine = new ReplayEngine(surface, { evidence });

      const result = await engine.replay(artifact, { memberId: '10234' }, { entryPoint: baseUrl });

      expect(result.status).toBe('success');
      expect(result.outputs?.savingsBalance).toBe('$8,920.14');
      expect(result.message).toBe('Replay completed successfully');

      // Verify evidence was produced
      const events = evidence.getAllEvents();
      expect(events.length).toBeGreaterThan(0);

      // Verify no LLM-related events exist
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).not.toContain('model_called');
      expect(eventTypes).not.toContain('llm_decision');
    });
  });

  it('should return business_outcome MEMBER_NOT_FOUND for unknown member', async () => {
    const artifact = loadArtifact('evidence/artifacts/lookup-member-savings-balance.json');

    await withSurface(async (surface) => {
      const evidence = new InMemoryEvidenceLogger();
      const engine = new ReplayEngine(surface, { evidence });

      const result = await engine.replay(artifact, { memberId: '99999' }, { entryPoint: baseUrl });

      expect(result.status).toBe('business_outcome');
      expect(result.category).toBe('BUSINESS_OUTCOME');
      expect(result.outputs).toEqual({ code: 'MEMBER_NOT_FOUND' });
    });
  });

  it('should return invalid_input for missing required parameter', async () => {
    const artifact = loadArtifact('evidence/artifacts/lookup-member-savings-balance.json');

    await withSurface(async (surface) => {
      const engine = new ReplayEngine(surface);

      // No params provided — memberId is required
      const result = await engine.replay(artifact, {}, { entryPoint: baseUrl });

      expect(result.status).toBe('invalid_input');
      expect(result.category).toBe('INVALID_INPUT');
    });
  });

  it('should return invalid_artifact for a structurally broken artifact', async () => {
    await withSurface(async (surface) => {
      const engine = new ReplayEngine(surface);

      // Pass a structurally invalid artifact (cast to bypass TS)
      const brokenArtifact = { id: 'broken', steps: [] } as any;
      const result = await engine.replay(brokenArtifact, {}, { entryPoint: baseUrl });

      expect(result.status).toBe('invalid_artifact');
      expect(result.category).toBe('INVALID_ARTIFACT');
    });
  });
});

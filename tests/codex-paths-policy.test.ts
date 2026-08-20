/** Codex discovery + policy tests: nested dirs, zstd skip, TTL branches. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanCodexSessions, isZstdFile } from '../src/adapters/codex/paths.js';
import { resolveTtlPolicy } from '../src/policy/provider-policy.js';
import type { CacheObservation } from '../src/types/index.js';

function codexObs(overrides: Partial<CacheObservation> & { timestamp: number }): CacheObservation {
  return {
    agent: 'codex',
    sessionId: 's1',
    requestId: `r${Math.random().toString(36).slice(2)}`,
    partial: false,
    source: 'test',
    inputTokens: 30_000,
    outputTokens: 100,
    cacheReadTokens: 28_000,
    cacheWriteTokens: 0,
    contextTokens: 30_000,
    ...overrides,
  };
}

function makeCodexHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cacheguard-codex-'));
}

const UUID = '01234567-89ab-cdef-0123-456789abcdef';
const ROLLOUT = `rollout-2026-08-20T10-00-00-${UUID}.jsonl`;

test('scan finds rollouts in date-nested dirs and archived_sessions/', () => {
  const home = makeCodexHome();
  const nested = path.join(home, 'sessions', '2026', '08', '20');
  fs.mkdirSync(nested, { recursive: true });
  fs.mkdirSync(path.join(home, 'archived_sessions'), { recursive: true });
  fs.writeFileSync(path.join(nested, ROLLOUT), '{}\n');
  fs.writeFileSync(path.join(home, 'archived_sessions', ROLLOUT), '{}\n');
  const scan = scanCodexSessions(home);
  assert.equal(scan.files.length, 2);
  assert.equal(scan.files[0]!.sessionId, UUID);
  assert.ok(scan.files.some((f) => f.projectDir === '2026/08/20'));
  assert.ok(scan.files.some((f) => f.projectDir === 'archived'));
});

test('scan skips and counts zstd rollouts (extension and magic bytes)', () => {
  const home = makeCodexHome();
  const nested = path.join(home, 'sessions', '2026', '08', '20');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, `rollout-2026-08-20T11-00-00-${UUID}.jsonl.zst`), 'x');
  // misnamed .jsonl that actually starts with the zstd frame magic
  const sneaky = path.join(nested, `rollout-2026-08-20T12-00-00-fedcba98-7654-3210-fedc-ba9876543210.jsonl`);
  fs.writeFileSync(sneaky, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01]));
  const scan = scanCodexSessions(home);
  assert.equal(scan.files.length, 0);
  assert.equal(scan.skippedZstd, 2);
  assert.equal(isZstdFile(sneaky), true);
});

test('scan ignores non-rollout jsonl files', () => {
  const home = makeCodexHome();
  const nested = path.join(home, 'sessions', '2026', '08', '20');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(nested, 'something-else.jsonl'), '{}\n');
  const scan = scanCodexSessions(home);
  assert.equal(scan.files.length, 0);
});

test('policy: codex + GPT-5.6 model → STATIC_POLICY 30 minutes', () => {
  const p = resolveTtlPolicy({
    agent: 'codex',
    model: 'gpt-5.6-sol',
    observations: [],
  });
  assert.equal(p.source, 'STATIC_POLICY');
  assert.equal(p.ttlMs, 30 * 60 * 1000);
  assert.ok(p.reason.includes('30-minute'));
});

test('policy: codex + pre-5.6 model → UNKNOWN (5-10min vs 24h indistinguishable)', () => {
  const p = resolveTtlPolicy({
    agent: 'codex',
    model: 'gpt-5.4',
    observations: [],
  });
  assert.equal(p.source, 'UNKNOWN');
  assert.ok(p.reason.includes('cannot be distinguished'));
  assert.ok(p.reliability <= 0.25);
});

test('policy: codex old model with survival evidence → EMPIRICAL overrides UNKNOWN', () => {
  const t0 = Date.parse('2026-08-20T12:00:00Z');
  const observations = [
    codexObs({ timestamp: t0, cacheReadTokens: 100_000, inputTokens: 101_000, contextTokens: 101_000 }),
    codexObs({ timestamp: t0 + 300_000, cacheReadTokens: 95_000, inputTokens: 102_000, contextTokens: 102_000 }),
    codexObs({ timestamp: t0 + 600_000, cacheReadTokens: 96_000, inputTokens: 103_000, contextTokens: 103_000 }),
    codexObs({ timestamp: t0 + 600_000 + 1_800_000, cacheReadTokens: 100, inputTokens: 104_000, contextTokens: 104_000 }),
  ];
  const p = resolveTtlPolicy({ agent: 'codex', model: 'gpt-5.4', observations });
  assert.equal(p.source, 'EMPIRICAL_ESTIMATE');
  assert.equal(p.ttlMs, Math.round(300_000 * 0.8)); // max survived gap 300s × haircut
});

test('policy: agent inferred from observations when parameter omitted', () => {
  const p = resolveTtlPolicy({
    observations: [codexObs({ timestamp: Date.now(), model: 'gpt-5.6-luna' })],
  });
  assert.equal(p.source, 'STATIC_POLICY');
  assert.equal(p.ttlMs, 30 * 60 * 1000);
});

test('policy: claude-code branch unchanged by codex additions', () => {
  const p = resolveTtlPolicy({
    observations: [],
    baseUrl: 'https://api.anthropic.com',
  });
  assert.equal(p.source, 'STATIC_POLICY');
  assert.equal(p.ttlMs, 5 * 60 * 1000);
});

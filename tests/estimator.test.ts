/** Estimator + policy tests: facts vs inference, state transitions, TTL sources. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateCacheState, classifyFact } from '../src/cache/estimator.js';
import { extractTtlEvidence, resolveTtlPolicy } from '../src/policy/provider-policy.js';
import type { CacheObservation } from '../src/types/index.js';

function obs(overrides: Partial<CacheObservation> & { timestamp: number }): CacheObservation {
  return {
    agent: 'claude-code',
    sessionId: 's1',
    requestId: `r${Math.random().toString(36).slice(2)}`,
    partial: false,
    source: 'test',
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 50_000,
    cacheWriteTokens: 0,
    contextTokens: 51_000,
    ...overrides,
  };
}

const T0 = Date.parse('2026-08-19T12:00:00.000Z');

test('no observations → UNKNOWN with zero confidence', () => {
  const est = estimateCacheState({ observations: [], now: T0 });
  assert.equal(est.state, 'UNKNOWN');
  assert.equal(est.confidence, 0);
  assert.ok(est.reason.length > 0);
});

test('fresh hit within 10s → VERIFIED_HIT (fact)', () => {
  const est = estimateCacheState({
    observations: [obs({ timestamp: T0 - 5_000 })],
    baseUrl: 'https://api.anthropic.com',
    now: T0,
  });
  assert.equal(est.state, 'VERIFIED_HIT');
  assert.ok(est.confidence > 0.8);
  assert.equal(est.lastFact?.kind, 'HIT');
});

test('hit older than fresh window but within TTL → LIKELY_HOT (inference)', () => {
  const est = estimateCacheState({
    observations: [obs({ timestamp: T0 - 60_000 })], // 1 min ago
    baseUrl: 'https://api.anthropic.com',
    now: T0,
  });
  assert.equal(est.state, 'LIKELY_HOT');
  assert.ok(est.confidence < 0.95, 'confidence must decay from the fresh-fact level');
  assert.equal(est.ttl?.source, 'STATIC_POLICY');
  assert.ok(est.reason.includes('Inference'));
});

test('approaching TTL → AT_RISK', () => {
  const est = estimateCacheState({
    observations: [obs({ timestamp: T0 - (5 * 60_000 - 30_000) })], // 30s before expiry
    baseUrl: 'https://api.anthropic.com',
    now: T0,
  });
  assert.equal(est.state, 'AT_RISK');
  assert.ok((est.ttlRemainingMs ?? 0) <= 60_000);
});

test('past TTL → LIKELY_EXPIRED, never VERIFIED (no new telemetry)', () => {
  const est = estimateCacheState({
    observations: [obs({ timestamp: T0 - 10 * 60_000 })],
    baseUrl: 'https://api.anthropic.com',
    now: T0,
  });
  assert.equal(est.state, 'LIKELY_EXPIRED');
  assert.ok(est.reason.includes('No new request has verified'));
});

test('miss with large context → VERIFIED_MISS (fact, sticky)', () => {
  const est = estimateCacheState({
    observations: [
      obs({ timestamp: T0 - 120_000, cacheReadTokens: 80_000, contextTokens: 81_000 }),
      obs({ timestamp: T0 - 30_000, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: 91_000, inputTokens: 91_000 }),
    ],
    baseUrl: 'https://api.anthropic.com',
    now: T0,
  });
  assert.equal(est.state, 'VERIFIED_MISS');
  assert.equal(est.lastFact?.kind, 'MISS');
  assert.equal(est.confidence, 0.95);
});

test('miss followed by rebuild (write>0) counts as new cache activity → HOT countdown', () => {
  const est = estimateCacheState({
    observations: [
      obs({ timestamp: T0 - 120_000, cacheReadTokens: 80_000, contextTokens: 81_000 }),
      obs({ timestamp: T0 - 60_000, cacheReadTokens: 0, cacheWriteTokens: 90_000, contextTokens: 91_000 }),
    ],
    baseUrl: 'https://api.anthropic.com',
    now: T0,
  });
  // last fact is MISS but cache was rebuilt → within TTL → LIKELY_HOT
  assert.equal(est.state, 'LIKELY_HOT');
  assert.equal(est.lastCacheActivityAt, T0 - 60_000);
});

test('partial miss classification: read far below previous context', () => {
  const prev = obs({ timestamp: T0 - 60_000, cacheReadTokens: 100_000, contextTokens: 101_000 });
  const next = obs({ timestamp: T0, cacheReadTokens: 2_000, contextTokens: 103_000 });
  const fact = classifyFact(next, prev);
  assert.equal(fact?.kind, 'PARTIAL_MISS');
});

test('tiny-context miss is NOT classified (noise guard)', () => {
  const next = obs({ timestamp: T0, cacheReadTokens: 0, contextTokens: 300, inputTokens: 300 });
  const fact = classifyFact(next, undefined);
  assert.equal(fact, null);
});

test('policy: native Anthropic endpoint → STATIC_POLICY 5m', () => {
  const p = resolveTtlPolicy({ observations: [], baseUrl: 'https://api.anthropic.com' });
  assert.equal(p.source, 'STATIC_POLICY');
  assert.equal(p.ttlMs, 300_000);
});

test('policy: ephemeral_1h evidence overrides static policy (RUNTIME_TELEMETRY)', () => {
  const p = resolveTtlPolicy({
    observations: [obs({ timestamp: T0, oneHourCacheTokens: 500 })],
    baseUrl: 'https://api.anthropic.com',
  });
  assert.equal(p.source, 'RUNTIME_TELEMETRY');
  assert.equal(p.ttlMs, 3_600_000);
});

test('policy: unknown gateway with no evidence → UNKNOWN, low reliability', () => {
  const p = resolveTtlPolicy({
    observations: [obs({ timestamp: T0 })],
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
  });
  assert.equal(p.source, 'UNKNOWN');
  assert.ok(p.reliability <= 0.3);
  assert.ok(p.reason.includes('open.bigmodel.cn'));
});

test('policy: gateway with survival evidence → EMPIRICAL_ESTIMATE with haircut', () => {
  const observations: CacheObservation[] = [];
  let t = T0;
  // three pairs: gap 300s survived, gap 400s survived, gap 200s survived
  for (const gap of [300_000, 400_000, 200_000]) {
    observations.push(obs({ timestamp: t, cacheReadTokens: 100_000, contextTokens: 101_000 }));
    observations.push(
      obs({ timestamp: t + gap, cacheReadTokens: 95_000, contextTokens: 102_000 }),
    );
    t += gap + 60_000;
  }
  const p = resolveTtlPolicy({
    observations,
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
  });
  assert.equal(p.source, 'EMPIRICAL_ESTIMATE');
  assert.equal(p.ttlMs, Math.round(400_000 * 0.8));
  assert.equal(p.observedSurvivedMs, 400_000);
});

test('evidence extraction separates survived vs expired gaps', () => {
  const observations = [
    obs({ timestamp: T0, cacheReadTokens: 100_000, contextTokens: 101_000 }),
    obs({ timestamp: T0 + 200_000, cacheReadTokens: 99_000, contextTokens: 102_000 }), // survived 200s
    obs({ timestamp: T0 + 200_000 + 900_000, cacheReadTokens: 300, contextTokens: 103_000 }), // missed 900s
  ];
  const ev = extractTtlEvidence(observations);
  assert.equal(ev.survivedGapsMs.length, 1);
  assert.equal(ev.expiredGapsMs.length, 1);
  assert.equal(ev.survivedGapsMs[0], 200_000);
});

test('small-context pairs are ignored as TTL evidence', () => {
  const observations = [
    obs({ timestamp: T0, cacheReadTokens: 100, contextTokens: 1_100, inputTokens: 1000 }),
    obs({ timestamp: T0 + 500_000, cacheReadTokens: 0, contextTokens: 1_200, inputTokens: 1200 }),
  ];
  const ev = extractTtlEvidence(observations);
  assert.equal(ev.survivedGapsMs.length, 0);
  assert.equal(ev.expiredGapsMs.length, 0);
});

test('every non-UNKNOWN estimate carries a reason naming its inputs', () => {
  for (const elapsed of [5_000, 60_000, 250_000, 400_000]) {
    const est = estimateCacheState({
      observations: [obs({ timestamp: T0 - elapsed })],
      baseUrl: 'https://api.anthropic.com',
      now: T0,
    });
    assert.ok(est.reason.length > 30, `reason too thin for elapsed=${elapsed}`);
    assert.ok(est.ttl !== undefined);
  }
});

test('policy: null baseUrl (endpoint hidden by --claude-dir) never claims STATIC_POLICY', () => {
  const p = resolveTtlPolicy({ observations: [], baseUrl: null });
  assert.equal(p.source, 'UNKNOWN');
  assert.ok(p.reason.includes('unverified'));
  assert.ok(p.reliability <= 0.3);
});

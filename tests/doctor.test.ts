/** Cache Doctor tests: attribution upgrade, recurring layers, clustering, advice evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDoctor } from '../src/doctor/analyze.js';
import { computeCostLedger } from '../src/cost/engine.js';
import type { CacheObservation } from '../src/types/index.js';

const T0 = Date.parse('2026-08-20T12:00:00.000Z');

function obs(overrides: Partial<CacheObservation> & { timestamp: number }): CacheObservation {
  return {
    agent: 'claude-code',
    sessionId: 's1',
    requestId: `r${overrides.timestamp}:${Math.random().toString(36).slice(2, 6)}`,
    model: 'claude-opus-5',
    partial: false,
    source: 'test',
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 100_000,
    cacheWriteTokens: 0,
    contextTokens: 101_000,
    ...overrides,
  };
}

test('model switch across a miss boundary outranks generic buckets', () => {
  const ledger = computeCostLedger({
    agent: 'claude-code',
    observations: [
      obs({ timestamp: T0 - 300_000, model: 'glm-5.2' }),
      obs({ timestamp: T0, model: 'glm-5.3', cacheReadTokens: 0, inputTokens: 100_000, contextTokens: 100_000 }),
    ],
  });
  const miss = ledger.verified.entries[0]!;
  assert.equal(miss.attribution, 'model-switch');
});

test('doctor reports model switch details with from/to models', () => {
  const report = analyzeDoctor({
    sessionId: 's1',
    agent: 'claude-code',
    observations: [
      obs({ timestamp: T0 - 300_000, model: 'glm-5.2' }),
      obs({ timestamp: T0, model: 'glm-5.3', cacheReadTokens: 0, inputTokens: 100_000, contextTokens: 100_000 }),
    ],
  });
  assert.equal(report.modelSwitches.length, 1);
  assert.equal(report.modelSwitches[0]!.from, 'glm-5.2');
  assert.equal(report.modelSwitches[0]!.to, 'glm-5.3');
  assert.ok(report.advice.some((a) => a.signal === 'model-switch' && a.evidence.includes('glm-5.2')));
});

test('doctor detects recurring residual layers from similar partial reads', () => {
  // two partial misses leaving ~21k readable, separated in time
  const report = analyzeDoctor({
    sessionId: 's1',
    agent: 'claude-code',
    observations: [
      obs({ timestamp: T0 - 600_000, cacheReadTokens: 100_000 }),
      obs({ timestamp: T0 - 300_000, cacheReadTokens: 21_376, inputTokens: 80_000, contextTokens: 100_000 }),
      obs({ timestamp: T0 - 60_000, cacheReadTokens: 90_000 }),
      obs({ timestamp: T0, cacheReadTokens: 21_504, inputTokens: 78_000, contextTokens: 100_000 }),
    ],
  });
  assert.equal(report.recurringLayers.length, 1);
  assert.equal(report.recurringLayers[0]!.occurrences, 2);
  assert.ok(Math.abs(report.recurringLayers[0]!.approxTokens - 21_440) < 100);
  assert.ok(report.advice.some((a) => a.signal === 'recurring-residual-layer'));
});

test('doctor clusters misses by local hour', () => {
  const t1 = Date.parse('2026-08-20T09:05:00Z');
  const t2 = Date.parse('2026-08-20T09:45:00Z');
  const report = analyzeDoctor({
    sessionId: 's1',
    agent: 'claude-code',
    observations: [
      obs({ timestamp: t1 - 300_000, cacheReadTokens: 100_000 }),
      obs({ timestamp: t1, cacheReadTokens: 0, inputTokens: 100_000, contextTokens: 100_000 }),
      obs({ timestamp: t2 - 60_000, cacheReadTokens: 100_000 }),
      obs({ timestamp: t2, cacheReadTokens: 0, inputTokens: 100_000, contextTokens: 100_000 }),
    ],
  });
  assert.equal(report.hourClusters.length, 1);
  assert.equal(report.hourClusters[0]!.events, 2);
});

test('advice only exists with evidence; no misses → no advice', () => {
  const report = analyzeDoctor({
    sessionId: 's1',
    agent: 'claude-code',
    observations: [obs({ timestamp: T0 }), obs({ timestamp: T0 + 60_000 })],
  });
  assert.equal(report.advice.length, 0);
  assert.equal(report.ledger.verified.entries.length, 0);
});

test('suspected-ttl advice names the evidence count', () => {
  const report = analyzeDoctor({
    sessionId: 's1',
    agent: 'claude-code',
    observations: [
      obs({ timestamp: T0 - 300_000, cacheReadTokens: 100_000 }),
      obs({ timestamp: T0, cacheReadTokens: 0, inputTokens: 100_000, contextTokens: 100_000 }),
    ],
  });
  const adv = report.advice.find((a) => a.signal === 'suspected-ttl')!;
  assert.ok(adv.evidence.includes('idle gaps'));
  // no certainty claims in advice text
  assert.ok(!/definitely|provably|will /.test(adv.text));
});

test('privacy note present on every report', () => {
  const report = analyzeDoctor({ sessionId: 's', agent: 'claude-code', observations: [] });
  assert.ok(report.privacyNote.includes('metadata-only'));
});

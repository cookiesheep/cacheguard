/**
 * Cost Engine tests — golden numbers first (docs/cost-engine.md §2.1),
 * then ledger honesty rules: verified vs inferred vs estimated separation,
 * quota mode, PRICING_UNKNOWN, attribution buckets, F2 interplay.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeCostLedger } from '../src/cost/engine.js';
import { resolvePricing } from '../src/cost/pricing.js';
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

/* ---------------- golden numbers ---------------- */

test('GOLDEN: Opus 5, 100k full miss, no rewrite → bleed = $0.45', () => {
  const ledger = computeCostLedger({
    agent: 'claude-code',
    observations: [
      obs({ timestamp: T0 - 120_000, cacheReadTokens: 100_000, inputTokens: 1_000, contextTokens: 101_000 }),
      obs({ timestamp: T0, cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 100_000, contextTokens: 100_000 }),
    ],
  });
  const miss = ledger.verified.entries.find((e) => e.kind === 'MISS')!;
  assert.equal(miss.bleedUsd, 0.45); // 100000×(5−0.5)/1e6
  assert.equal(ledger.verified.bleedUsd, 0.45);
});

test('GOLDEN: Opus 5, 100k full miss with 5m full rewrite → +$0.575, total $1.025', () => {
  const ledger = computeCostLedger({
    agent: 'claude-code',
    observations: [
      obs({ timestamp: T0 - 120_000, cacheReadTokens: 100_000, inputTokens: 1_000, contextTokens: 101_000 }),
      // Anthropic accounting: input (uncached) and cache_creation are disjoint —
      // a full miss + full rewrite of a 100k prompt is in=100k, cc=100k, ctx=200k.
      obs({ timestamp: T0, cacheReadTokens: 0, cacheWriteTokens: 100_000, inputTokens: 100_000, contextTokens: 200_000 }),
    ],
  });
  const miss = ledger.verified.entries.find((e) => e.kind === 'MISS')!;
  // 100000×(5−0.5)/1e6 + 100000×(6.25−0.5)/1e6 = 0.45 + 0.575
  assert.equal(miss.bleedUsd, 0.45 + 0.575);
  assert.equal(ledger.verified.bleedUsd, 1.025);
});

test('GOLDEN: pre-5.6 gpt (gpt-5.3-codex) miss has NO write surcharge term', () => {
  const ledger = computeCostLedger({
    agent: 'codex',
    observations: [
      {
        ...obs({ timestamp: T0 - 120_000, cacheReadTokens: 100_000, inputTokens: 101_000, contextTokens: 101_000 }),
        agent: 'codex',
        model: 'gpt-5.3-codex',
      },
      {
        ...obs({ timestamp: T0, cacheReadTokens: 0, inputTokens: 100_000, contextTokens: 100_000 }),
        agent: 'codex',
        model: 'gpt-5.3-codex',
      },
    ],
  });
  const miss = ledger.verified.entries.find((e) => e.kind === 'MISS')!;
  // openai semantics: uncached = input − cached = 100000; 100000×(1.75−0.175)/1e6
  assert.equal(miss.bleedUsd, 0.1575);
  assert.equal(miss.inferredWriteSurchargeUsd, undefined); // no write price for pre-5.6
  assert.equal(miss.lowerBound, true);
});

test('GOLDEN: gpt-5.6 miss → lower bound + inferred write surcharge kept OUT of verified', () => {
  const ledger = computeCostLedger({
    agent: 'codex',
    observations: [
      {
        ...obs({ timestamp: T0 - 120_000, cacheReadTokens: 100_000, inputTokens: 101_000, contextTokens: 101_000 }),
        agent: 'codex',
        model: 'gpt-5.6-sol',
        cacheWriteUnknown: true,
      },
      {
        ...obs({ timestamp: T0, cacheReadTokens: 0, inputTokens: 100_000, contextTokens: 100_000 }),
        agent: 'codex',
        model: 'gpt-5.6-sol',
        cacheWriteUnknown: true,
      },
    ],
  });
  const miss = ledger.verified.entries.find((e) => e.kind === 'MISS')!;
  // uncached = 100000 − 0; 100000×(5−0.5)/1e6 = 0.45 — LOWER BOUND only
  assert.equal(miss.bleedUsd, 0.45);
  assert.equal(miss.lowerBound, true);
  // inferred write surcharge = 100000×(6.25−0.5)/1e6 = 0.575 — displayed, never summed
  assert.equal(miss.inferredWriteSurchargeUsd, 0.575);
  assert.equal(ledger.verified.bleedUsd, 0.45);
  assert.notEqual(ledger.verified.bleedUsd, 1.025);
});

test('GOLDEN: GLM session → token ledger only, no USD anywhere', () => {
  const ledger = computeCostLedger({
    agent: 'claude-code',
    observations: [
      obs({ timestamp: T0 - 120_000, model: 'glm-5.2' }),
      obs({ timestamp: T0, model: 'glm-5.2', cacheReadTokens: 384, cacheWriteTokens: 0, inputTokens: 100_000, contextTokens: 100_384 }),
    ],
  });
  assert.equal(ledger.pricingStatus.kind, 'quota');
  assert.equal(ledger.verified.bleedUsd, undefined);
  assert.equal(ledger.spendUsd, undefined);
  assert.equal(ledger.estimated.coldExposureUsd, undefined);
  assert.ok(ledger.verified.lostContextTokens > 0); // token account still exists
  const miss = ledger.verified.entries[0]!;
  assert.equal(miss.bleedUsd, undefined);
  assert.ok(miss.note!.includes('quota'));
});

/* ---------------- honesty rules ---------------- */

test('PRICING_UNKNOWN model → no USD, token ledger only', () => {
  const ledger = computeCostLedger({
    agent: 'claude-code',
    observations: [
      obs({ timestamp: T0 - 120_000, model: 'claude-opus-4-1' }), // deliberately not in snapshot (not audit-verified)
      obs({ timestamp: T0, model: 'claude-opus-4-1', cacheReadTokens: 0, inputTokens: 50_000, contextTokens: 50_000 }),
    ],
  });
  assert.equal(ledger.pricingStatus.kind, 'PRICING_UNKNOWN');
  assert.equal(ledger.verified.bleedUsd, undefined);
  assert.equal(ledger.spendUsd, undefined);
});

test('verified ledger only contains MISS/PARTIAL facts — HITs never bill', () => {
  const ledger = computeCostLedger({
    agent: 'claude-code',
    observations: [
      obs({ timestamp: T0 - 60_000, cacheReadTokens: 100_000 }),
      obs({ timestamp: T0 - 30_000, cacheReadTokens: 100_000 }),
      obs({ timestamp: T0, cacheReadTokens: 99_000 }),
    ],
  });
  assert.equal(ledger.verified.entries.length, 0);
  assert.equal(ledger.verified.bleedUsd, undefined);
});

test('officialCostUsd is preferred for spend (source: official)', () => {
  const ledger = computeCostLedger({
    agent: 'claude-code',
    observations: [obs({ timestamp: T0, officialCostUsd: 0.42 })],
  });
  assert.equal(ledger.spendUsd?.source, 'official');
  assert.ok(Math.abs(ledger.spendUsd!.prefillUsd - 0.42) < 1e-9);
});

test('estimated cold exposure uses current context × (p_in − p_read)', () => {
  const ledger = computeCostLedger({
    agent: 'claude-code',
    observations: [obs({ timestamp: T0, contextTokens: 200_000, cacheReadTokens: 200_000, inputTokens: 0 })],
  });
  // 200000×(5−0.5)/1e6 = 0.9
  assert.equal(ledger.estimated.coldExposureUsd, 0.9);
});

/* ---------------- attribution buckets ---------------- */

test('attribution: long gap + stable context → suspected-ttl', () => {
  const ledger = computeCostLedger({
    agent: 'claude-code',
    observations: [
      obs({ timestamp: T0 - 300_000, cacheReadTokens: 100_000 }),
      obs({ timestamp: T0, cacheReadTokens: 0, inputTokens: 100_000, contextTokens: 100_000 }),
    ],
  });
  assert.equal(ledger.verified.entries[0]!.attribution, 'suspected-ttl');
});

test('attribution: context collapse → compaction', () => {
  const ledger = computeCostLedger({
    agent: 'claude-code',
    observations: [
      obs({ timestamp: T0 - 300_000, cacheReadTokens: 100_000, contextTokens: 101_000 }),
      obs({ timestamp: T0, cacheReadTokens: 0, inputTokens: 20_000, contextTokens: 20_000 }),
    ],
  });
  assert.equal(ledger.verified.entries[0]!.attribution, 'compaction');
});

test('attribution: short gap miss → suspected-prefix-break', () => {
  const ledger = computeCostLedger({
    agent: 'claude-code',
    observations: [
      obs({ timestamp: T0 - 10_000, cacheReadTokens: 100_000 }),
      obs({ timestamp: T0, cacheReadTokens: 0, inputTokens: 100_000, contextTokens: 100_000 }),
    ],
  });
  assert.equal(ledger.verified.entries[0]!.attribution, 'suspected-prefix-break');
});

/* ---------------- pricing resolution ---------------- */

test('pricing: prefix matching and variants', () => {
  assert.equal(resolvePricing('claude-opus-5-20260801').kind, 'priced');
  assert.equal(resolvePricing('gpt-5.6-sol').kind, 'priced');
  assert.equal(resolvePricing('glm-5.3').kind, 'quota');
  assert.equal(resolvePricing('sonnet').kind, 'PRICING_UNKNOWN'); // bare alias: no guessing
  assert.equal(resolvePricing(undefined).kind, 'PRICING_UNKNOWN');
  const p = resolvePricing('claude-sonnet-4-5');
  assert.ok(p.kind === 'priced');
  assert.equal(p.entry.cacheReadPerMTok, 0.3);
  assert.equal(p.entry.cacheWrite5mPerMTok, 3.75);
});

/* ---------------- F2 interplay ---------------- */

test('degenerate context=0 observations never produce bleed entries', () => {
  const ledger = computeCostLedger({
    agent: 'claude-code',
    observations: [
      obs({ timestamp: T0 - 60_000, cacheReadTokens: 100_000 }),
      obs({ timestamp: T0, cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, contextTokens: 0 }),
    ],
  });
  assert.equal(ledger.verified.entries.length, 0);
});

/* ---------------- F3: snapshot completion golden numbers ---------------- */

test('F3 GOLDEN: every newly added model resolves with audit-verified prices', () => {
  const expected: Array<[string, number, number, number, number]> = [
    // model, input, read, write5m, write1h  ($/MTok, audit §1.2)
    ['claude-fable-5', 5, 0.5, 6.25, 10],
    ['claude-mythos-5', 2.5, 0.25, 3.125, 5],
    ['claude-sonnet-5', 3, 0.3, 3.75, 6],
    ['claude-opus-4-8', 5, 0.5, 6.25, 10],
    ['claude-sonnet-4-6', 3, 0.3, 3.75, 6],
    ['claude-opus-4-5', 15, 1.5, 18.75, 30],
  ];
  for (const [model, inp, rd, w5, w1h] of expected) {
    const p = resolvePricing(model);
    assert.equal(p.kind, 'priced', model);
    if (p.kind !== 'priced') continue;
    assert.equal(p.entry.inputPerMTok, inp, `${model} input`);
    assert.equal(p.entry.cacheReadPerMTok, rd, `${model} read`);
    assert.equal(p.entry.cacheWrite5mPerMTok, w5, `${model} write5m`);
    assert.equal(p.entry.cacheWrite1hPerMTok, w1h, `${model} write1h`);
  }
});

test('F3: opus-4-1 stays PRICING_UNKNOWN (not in audit — principle preserved)', () => {
  assert.equal(resolvePricing('claude-opus-4-1-20250415').kind, 'PRICING_UNKNOWN');
});

test('F3 GOLDEN: opus-4-5 bleed uses the 15/1.5 price line', () => {
  const ledger = computeCostLedger({
    agent: 'claude-code',
    observations: [
      obs({ timestamp: T0 - 120_000, model: 'claude-opus-4-5', cacheReadTokens: 100_000 }),
      obs({ timestamp: T0, model: 'claude-opus-4-5', cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 100_000, contextTokens: 100_000 }),
    ],
  });
  // 100000×(15−1.5)/1e6 = 1.35
  assert.equal(ledger.verified.bleedUsd, 1.35);
});

test('F3 GOLDEN: mythos-5 partial miss at the 2.5/0.25 price line', () => {
  const ledger = computeCostLedger({
    agent: 'claude-code',
    observations: [
      obs({ timestamp: T0 - 120_000, model: 'claude-mythos-5', cacheReadTokens: 100_000 }),
      obs({ timestamp: T0, model: 'claude-mythos-5', cacheReadTokens: 20_000, inputTokens: 80_000, contextTokens: 100_000 }),
    ],
  });
  // uncached=80000×(2.5−0.25)/1e6 = 0.18
  assert.equal(ledger.verified.entries[0]!.bleedUsd, 0.18);
});

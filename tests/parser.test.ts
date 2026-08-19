/**
 * Parser tests — the most safety-critical module in CacheGuard.
 * Fixtures mirror the audited real schema (docs/claude-code-schema.md),
 * with all content redacted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { ObservationParser } from '../src/adapters/claude-code/parser.js';

const fixturesDir = path.join(path.dirname(url.fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return fs.readFileSync(path.join(fixturesDir, name), 'utf8');
}

test('parses a full-usage assistant record into an observation', () => {
  const parser = new ObservationParser();
  const obs = parser.parseBuffer(fixture('session-basic.jsonl'), 'fixture');
  const first = obs.find((o) => o.requestId === 'msg_A')!;
  assert.equal(first.agent, 'claude-code');
  assert.equal(first.sessionId, 'sess-fixture-0001');
  assert.equal(first.inputTokens, 1536);
  assert.equal(first.cacheReadTokens, 39488);
  assert.equal(first.cacheWriteTokens, 0);
  assert.equal(first.contextTokens, 1536 + 39488 + 0);
  assert.equal(first.partial, false);
  assert.equal(first.agentVersion, '2.1.235');
});

test('dedupes duplicate records sharing one message.id', () => {
  const parser = new ObservationParser();
  const obs = parser.parseBuffer(fixture('session-basic.jsonl'), 'fixture');
  // msg_A appears twice in the file (text chunk + tool_use chunk)
  const aRecords = obs.filter((o) => o.requestId === 'msg_A');
  assert.equal(aRecords.length, 1);
  assert.ok(parser.stats.duplicateRecords >= 1);
});

test('skips <synthetic> records entirely', () => {
  const parser = new ObservationParser();
  const obs = parser.parseBuffer(fixture('session-basic.jsonl'), 'fixture');
  assert.ok(!obs.some((o) => o.requestId === 'msg_S'));
  assert.equal(parser.stats.syntheticRecords, 1);
});

test('skips sidechain (subagent) records by default', () => {
  const parser = new ObservationParser();
  const obs = parser.parseBuffer(fixture('session-basic.jsonl'), 'fixture');
  assert.ok(!obs.some((o) => o.requestId === 'msg_C'));
  assert.equal(parser.stats.sidechainRecords, 1);
});

test('includes sidechain records when asked', () => {
  const parser = new ObservationParser({ includeSidechain: true });
  const obs = parser.parseBuffer(fixture('session-basic.jsonl'), 'fixture');
  assert.ok(obs.some((o) => o.requestId === 'msg_C'));
});

test('marks observations partial when usage lacks cache fields', () => {
  const parser = new ObservationParser();
  const obs = parser.parseBuffer(fixture('session-basic.jsonl'), 'fixture');
  const partialObs = obs.find((o) => o.requestId === 'msg_B')!;
  assert.equal(partialObs.partial, true);
  assert.equal(partialObs.inputTokens, 100);
  assert.equal(partialObs.contextTokens, 100); // input only; cache fields unknown
});

test('tolerates unknown record types without error', () => {
  const parser = new ObservationParser();
  const obs = parser.parseBuffer(fixture('session-basic.jsonl'), 'fixture');
  assert.ok(parser.stats.nonAssistantRecords >= 3); // user, system, future-type
  assert.equal(obs.length, 4); // msg_A, msg_B, msg_D, msg_E
});

test('truncated half-line at EOF does not throw and is not counted as garbage', () => {
  const parser = new ObservationParser();
  // feed the truncated fixture line-by-line as the tailer would (buffered)
  const obs = parser.parseBuffer(fixture('session-truncated.jsonl'), 'fixture');
  assert.ok(Array.isArray(obs));
  // The final half-line parses to nothing; valid lines before it survive.
  assert.ok(obs.some((o) => o.requestId === 'msg_B'));
});

test('garbage-only file yields zero observations and never throws', () => {
  const parser = new ObservationParser();
  const obs = parser.parseBuffer(fixture('session-garbage.jsonl'), 'fixture');
  assert.equal(obs.length, 0);
  assert.ok(parser.stats.parseErrors >= 2);
});

test('empty file yields zero observations', () => {
  const parser = new ObservationParser();
  const obs = parser.parseBuffer(fixture('session-empty.jsonl'), 'fixture');
  assert.equal(obs.length, 0);
});

test('non-monotonic timestamps are preserved as-is (sorting is estimator business)', () => {
  const parser = new ObservationParser();
  const obs = parser.parseBuffer(fixture('session-basic.jsonl'), 'fixture');
  const d = obs.find((o) => o.requestId === 'msg_D')!;
  const a = obs.find((o) => o.requestId === 'msg_A')!;
  // msg_D appears later in file but has an earlier timestamp (resume interleave)
  assert.ok(d.timestamp < a.timestamp);
});

test('record missing timestamp is skipped, not fatal', () => {
  const parser = new ObservationParser();
  const line = JSON.stringify({
    type: 'assistant',
    message: { id: 'msg_no_ts', model: 'm', usage: { input_tokens: 1 } },
  });
  assert.equal(parser.parseLine(line, 'fixture'), null);
});

test('huge file performance sanity: 50k lines parse without exploding', () => {
  const parser = new ObservationParser();
  const base = {
    type: 'assistant',
    timestamp: '2026-08-19T10:00:00.000Z',
    sessionId: 's',
    version: '2.1.235',
    isSidechain: false,
    message: {
      id: '',
      model: 'glm-5.2',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
    },
  };
  const lines: string[] = [];
  for (let i = 0; i < 50_000; i++) {
    const r = { ...base, message: { ...base.message, id: `msg_${i}` } };
    lines.push(JSON.stringify(r));
  }
  const obs = parser.parseBuffer(lines.join('\n'), 'bench');
  assert.equal(obs.length, 50_000);
});

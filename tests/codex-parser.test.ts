/**
 * Codex parser tests — robustness contract mirrors the Claude Code parser.
 * Fixtures: synthetic (deterministic) + real-derived sanitized sample from
 * a local gpt-5.4 session (2026-03-07, codex-cli 0.147).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { CodexParser, isGpt56OrLater } from '../src/adapters/codex/parser.js';

const fixturesDir = path.join(path.dirname(url.fileURLToPath(import.meta.url)), 'fixtures', 'codex');

function fixture(name: string): string {
  return fs.readFileSync(path.join(fixturesDir, name), 'utf8');
}

test('parses token_count events with ambient model from turn_context', () => {
  const parser = new CodexParser();
  const obs = parser.parseBuffer(fixture('session-basic.jsonl'), 'fixture');
  assert.equal(obs.length, 3);
  const first = obs[0]!;
  assert.equal(first.agent, 'codex');
  assert.equal(first.sessionId, 'conv-synth-0001');
  assert.equal(first.model, 'gpt-5.6-sol'); // from ambient turn_context
  assert.equal(first.agentVersion, '0.147.0');
  assert.equal(first.inputTokens, 20_000);
  assert.equal(first.cacheReadTokens, 12_000);
  assert.equal(first.cacheWriteTokens, 0);
  // VERIFIED convention: context = input (cached is a SUBSET, not additive)
  assert.equal(first.contextTokens, 20_000);
});

test('model switches when a later turn_context names a different model', () => {
  const parser = new CodexParser();
  const obs = parser.parseBuffer(fixture('session-basic.jsonl'), 'fixture');
  const old = obs.find((o) => o.model === 'gpt-5.4')!;
  assert.ok(old);
  assert.equal(old.inputTokens, 30_000);
});

test('info:null token_count is skipped, never fatal (real-data behavior)', () => {
  const parser = new CodexParser();
  const obs = parser.parseBuffer(fixture('session-basic.jsonl'), 'fixture');
  assert.equal(obs.length, 3);
  assert.ok(parser.stats.syntheticRecords >= 1);
});

test('missing cache_write field → cacheWriteUnknown=true (never read as fact 0)', () => {
  const parser = new CodexParser();
  const obs = parser.parseBuffer(fixture('session-basic.jsonl'), 'fixture');
  const old = obs.find((o) => o.model === 'gpt-5.4')!; // fixture omits the field
  assert.equal(old.cacheWriteUnknown, true);
  assert.equal(old.cacheWriteTokens, 0);
});

test('pre-5.6 model with explicit cache_write=0 → still unknown, not a fact', () => {
  const parser = new CodexParser();
  parser.parseBuffer(
    JSON.stringify({
      timestamp: '2026-08-20T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'x', cli_version: '0.147.0' },
    }) + '\n',
    'f',
  );
  const obs = parser.parseLine(
    JSON.stringify({
      timestamp: '2026-08-20T10:00:01.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 1000, cached_input_tokens: 500,
            cache_write_input_tokens: 0, output_tokens: 10, total_tokens: 1010,
          },
        },
      },
    }),
    'f',
  );
  // ambient model is undefined here; parser keeps last known (none) → not 5.6
  assert.equal(obs?.cacheWriteUnknown, true);
});

test('gpt-5.6 with cache_write present → cacheWriteUnknown=false', () => {
  const parser = new CodexParser();
  const obs = parser.parseBuffer(fixture('session-basic.jsonl'), 'fixture');
  const m56 = obs.find((o) => o.model === 'gpt-5.6-sol')!;
  assert.equal(m56.cacheWriteUnknown, false);
});

test('unknown record types and content-bearing lines are skipped, not errors', () => {
  const parser = new CodexParser();
  const obs = parser.parseBuffer(fixture('session-basic.jsonl'), 'fixture');
  assert.equal(obs.length, 3);
  assert.ok(parser.stats.nonAssistantRecords >= 4); // session_meta, turn_context ×2, future type, response_item, compacted
});

test('garbage and empty files never throw', () => {
  assert.deepEqual(new CodexParser().parseBuffer(fixture('session-garbage.jsonl'), 'f'), []);
  assert.deepEqual(new CodexParser().parseBuffer(fixture('session-empty.jsonl'), 'f'), []);
  const obs = new CodexParser().parseBuffer(fixture('session-truncated.jsonl'), 'f');
  assert.ok(obs.length >= 1);
});

test('requestId is stable across independent re-parses (dedupe key)', () => {
  const a = new CodexParser().parseBuffer(fixture('session-basic.jsonl'), 'f');
  const b = new CodexParser().parseBuffer(fixture('session-basic.jsonl'), 'f');
  assert.deepEqual(
    a.map((o) => o.requestId),
    b.map((o) => o.requestId),
  );
});

test('same line fed twice to one parser dedupes', () => {
  const parser = new CodexParser();
  const line = JSON.stringify({
    timestamp: '2026-08-20T10:00:05.000Z',
    type: 'event_msg',
    payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 1, total_tokens: 6 } } },
  });
  assert.ok(parser.parseLine(line, 'f'));
  assert.equal(parser.parseLine(line, 'f'), null);
  assert.equal(parser.stats.duplicateRecords, 1);
});

test('ambientFromHead extracts meta without producing observations', () => {
  const ambient = CodexParser.ambientFromHead(fixture('session-basic.jsonl').split('\n').slice(0, 2).join('\n'));
  assert.equal(ambient.conversationId, 'conv-synth-0001');
  assert.equal(ambient.cliVersion, '0.147.0');
  assert.equal(ambient.modelProvider, 'custom');
  assert.equal(ambient.model, 'gpt-5.6-sol');
});

test('real-derived fixture (gpt-5.4, local data) parses end-to-end', () => {
  const parser = new CodexParser();
  const obs = parser.parseBuffer(fixture('session-real-derived.jsonl'), 'real-derived');
  assert.ok(obs.length > 50, `expected real token_counts, got ${obs.length}`);
  assert.ok(obs.every((o) => o.agent === 'codex'));
  assert.ok(obs.every((o) => o.contextTokens === o.inputTokens));
  // gpt-5.4 cannot report writes — flag must be set on every observation
  assert.ok(obs.every((o) => o.cacheWriteUnknown === true));
  // cached never exceeds input (subset convention, sanity against real data)
  for (const o of obs) {
    assert.ok((o.cacheReadTokens ?? 0) <= (o.inputTokens ?? 0));
  }
});

test('isGpt56OrLater boundary cases', () => {
  assert.equal(isGpt56OrLater('gpt-5.6-sol'), true);
  assert.equal(isGpt56OrLater('GPT-5.6'), true);
  assert.equal(isGpt56OrLater('gpt-5.7'), true);
  assert.equal(isGpt56OrLater('gpt-5.4'), false);
  assert.equal(isGpt56OrLater('gpt-5'), false);
  assert.equal(isGpt56OrLater(undefined), false);
});

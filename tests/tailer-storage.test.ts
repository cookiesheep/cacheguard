/** Tailer + storage tests: incremental reads, partial lines, dedupe, events. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonlTailer, readTailSnapshot } from '../src/collector/tailer.js';
import { CacheGuardStore } from '../src/storage/db.js';
import type { CacheObservation } from '../src/types/index.js';

function tmpFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cacheguard-test-'));
  return path.join(dir, name);
}

function line(id: string, n: number): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(1_700_000_000_000 + n * 1000).toISOString(),
    sessionId: 's',
    message: { id, model: 'm', usage: { input_tokens: n, output_tokens: 1, cache_read_input_tokens: n * 10, cache_creation_input_tokens: 0 } },
  });
}

test('tailer: reads existing content, then appends incrementally', async () => {
  const file = tmpFile('a.jsonl');
  fs.writeFileSync(file, line('m1', 1) + '\n' + line('m2', 2) + '\n');
  const chunks: string[] = [];
  const tailer = new JsonlTailer(file, { pollMs: 50, onLines: (t) => chunks.push(t) });
  tailer.start();
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0]!.includes('m1'));
  assert.ok(chunks[0]!.includes('m2'));

  fs.appendFileSync(file, line('m3', 3) + '\n');
  await sleep(300);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[1]!.includes('m3'));
  assert.ok(!chunks[1]!.includes('m1'), 'incremental: must not re-emit old bytes');
  tailer.stop();
});

test('tailer: buffers partial trailing line until completed', async () => {
  const file = tmpFile('b.jsonl');
  const partial = line('m1', 1).slice(0, 40);
  fs.writeFileSync(file, partial);
  const chunks: string[] = [];
  const tailer = new JsonlTailer(file, { pollMs: 50, onLines: (t) => chunks.push(t) });
  tailer.start();
  assert.equal(chunks.length, 0, 'partial line must not be emitted');

  const rest = line('m1', 1).slice(40) + '\n';
  fs.appendFileSync(file, rest);
  await sleep(300);
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0]!.includes('"m1'));
  tailer.stop();
});

test('tailer: detects truncation and re-reads', async () => {
  const file = tmpFile('c.jsonl');
  fs.writeFileSync(file, line('m1', 1) + '\n' + line('m2', 2) + '\n');
  let truncated = false;
  const chunks: string[] = [];
  const tailer = new JsonlTailer(file, {
    pollMs: 50,
    onLines: (t) => chunks.push(t),
    onTruncate: () => {
      truncated = true;
    },
  });
  tailer.start();
  fs.writeFileSync(file, line('fresh', 9) + '\n'); // replace with shorter content
  await sleep(300);
  assert.ok(truncated);
  assert.ok(chunks.some((c) => c.includes('fresh')));
  tailer.stop();
});

test('readTailSnapshot aligns to line boundary and caps bytes', () => {
  const file = tmpFile('d.jsonl');
  const lines = Array.from({ length: 100 }, (_, i) => line(`m${i}`, i)).join('\n') + '\n';
  fs.writeFileSync(file, lines);
  const bytes = Buffer.byteLength(line('m0', 0)) + 10;
  const { text, skippedBytes } = readTailSnapshot(file, bytes);
  assert.ok(skippedBytes > 0);
  assert.ok(text.startsWith('{'), 'must start at a line boundary');
  const ids = text.split('\n').filter(Boolean).map((l) => JSON.parse(l).message.id);
  assert.ok(ids.length >= 1 && ids.length <= 3);
  assert.ok(ids.every((id: string) => id.startsWith('m')));
});

test('storage: insertObservations dedupes on (session, requestId) across runs', () => {
  const store = new CacheGuardStore(tmpFile('e.db'));
  store.upsertSession({ sessionId: 'sess1', agent: 'claude-code' });
  const o = (id: string, n: number): CacheObservation => ({
    timestamp: 1_700_000_000_000 + n * 1000,
    agent: 'claude-code',
    sessionId: 'sess1',
    requestId: id,
    inputTokens: n,
    outputTokens: n,
    cacheReadTokens: n * 10,
    cacheWriteTokens: 0,
    contextTokens: n * 11,
    partial: false,
    source: 'test',
  });
  assert.equal(store.insertObservations([o('a', 1), o('b', 2)]).length, 2);
  assert.equal(store.insertObservations([o('a', 1), o('c', 3)]).length, 1); // 'a' ignored
  assert.deepEqual(
    store.insertObservations([o('a', 1)]).map((x) => x.requestId),
    [],
  );
  const all = store.observationsFor('sess1');
  assert.equal(all.length, 3);
  assert.equal(store.observationCount('sess1'), 3);
  store.close();
});

test('storage: session upsert keeps earliest startedAt and latest lastSeen', () => {
  const store = new CacheGuardStore(tmpFile('f.db'));
  store.upsertSession({ sessionId: 's', agent: 'claude-code', startedAt: 200, lastSeen: 300 });
  store.upsertSession({ sessionId: 's', agent: 'claude-code', startedAt: 100, lastSeen: 250 });
  const sess = store.listSessions().find((x) => x.sessionId === 's')!;
  assert.equal(sess.startedAt, 100);
  assert.equal(sess.lastSeen, 300);
  store.close();
});

test('storage: events round-trip', () => {
  const store = new CacheGuardStore(tmpFile('g.db'));
  store.insertEvent({
    sessionId: 's',
    timestamp: 123,
    eventType: 'VERIFIED_MISS',
    detail: '{"cacheReadTokens":0}',
  });
  const events = store.eventsFor('s');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.eventType, 'VERIFIED_MISS');
  store.close();
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

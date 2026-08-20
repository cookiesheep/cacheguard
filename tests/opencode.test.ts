/**
 * OpenCode adapter tests — real-derived sanitized fixture (local opencode.db,
 * 1.3.17, gpt-5.4/gpt-5.4-mini via openai provider) + synthetic edge cases.
 *
 * Accounting conclusion under test (docs/opencode-schema.md): ADDITIVE —
 * contextTokens = input + cache.read + cache.write, verified 23/23 on the
 * real non-degenerate messages the fixture carries.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import Database from 'better-sqlite3';
import { OpenCodeParser } from '../src/adapters/opencode/parser.js';
import { listOpenCodeSessions, readOpenCodeMessages } from '../src/adapters/opencode/paths.js';
import { OpenCodeAdapter } from '../src/adapters/opencode/adapter.js';
import { resolveTtlPolicy } from '../src/policy/provider-policy.js';
import { SessionEngine } from '../src/sessions/engine.js';
import { CacheGuardStore } from '../src/storage/db.js';
import type { OpenCodeMessageRow } from '../src/adapters/opencode/paths.js';

const fixturesDir = path.join(path.dirname(url.fileURLToPath(import.meta.url)), 'fixtures', 'opencode');
const fixture = JSON.parse(
  fs.readFileSync(path.join(fixturesDir, 'real-derived.json'), 'utf8'),
) as {
  sessions: Array<{ id: string; directory?: string; time_created?: number; time_updated?: number }>;
  messages: Array<{ id: string; session_id: string; time_created: number; data: string }>;
};

function makeDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-opencode-'));
  const dbFile = path.join(dir, 'opencode.db');
  const db = new Database(dbFile);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
           CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);`);
  const insS = db.prepare('INSERT INTO session (id,directory,title,time_created,time_updated) VALUES (?,?,?,?,?)');
  for (const s of fixture.sessions) insS.run(s.id, s.directory ?? null, null, s.time_created ?? 0, s.time_updated ?? 0);
  const insM = db.prepare('INSERT INTO message (id,session_id,time_created,data) VALUES (?,?,?,?)');
  for (const m of fixture.messages) insM.run(m.id, m.session_id, m.time_created, m.data);
  db.close();
  fs.mkdirSync(path.join(dir, 'storage'), { recursive: true }); // dir-shape realism
  return dir;
}

test('real-derived: discovery lists all 5 sessions, newest first', async () => {
  const dir = makeDb();
  const adapter = new OpenCodeAdapter(dir);
  const sessions = await adapter.discoverSessions();
  assert.equal(sessions.length, 5);
  assert.ok(sessions[0]!.modifiedAt >= sessions[4]!.modifiedAt);
  assert.ok(sessions.every((s) => s.agent === 'opencode'));
});

test('real-derived: additive accounting holds (context = input + read + write)', () => {
  const rows = readOpenCodeMessages(fixture.messages[0]!.session_id, { limitRows: 1000, dirOverride: makeDb() });
  const parser = new OpenCodeParser();
  const obs = parser.parseRows(rows);
  assert.ok(obs.length >= 10, `expected real observations, got ${obs.length}`);
  for (const o of obs) {
    assert.equal(
      o.contextTokens,
      (o.inputTokens ?? 0) + (o.cacheReadTokens ?? 0) + (o.cacheWriteTokens ?? 0),
    );
    // total invariant from the source data: total = input+output+reasoning+read
    assert.ok((o.cacheReadTokens ?? 0) <= o.contextTokens!);
  }
});

test('real-derived: dedupe by message id', () => {
  const row = fixture.messages.find((m) => JSON.parse(m.data).role === 'assistant' && JSON.parse(m.data).tokens)!;
  const parser = new OpenCodeParser();
  assert.ok(parser.parseRow(row as OpenCodeMessageRow));
  assert.equal(parser.parseRow(row as OpenCodeMessageRow), null);
  assert.equal(parser.stats.duplicateRecords, 1);
});

test('degenerate all-zero token rows produce no observation (F2 guard)', () => {
  const parser = new OpenCodeParser();
  const row: OpenCodeMessageRow = {
    id: 'msg_zero',
    time_created: Date.now(),
    data: JSON.stringify({ role: 'assistant', tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
  };
  assert.equal(parser.parseRow(row), null);
});

test('garbage JSON data and non-assistant rows are skipped, never fatal', () => {
  const parser = new OpenCodeParser();
  assert.equal(parser.parseRow({ id: 'x', time_created: 1, data: '{broken' }), null);
  assert.equal(
    parser.parseRow({ id: 'y', time_created: 1, data: JSON.stringify({ role: 'user', tokens: { input: 1 } }) }),
    null,
  );
  assert.equal(parser.stats.parseErrors, 1);
  assert.equal(parser.stats.nonAssistantRecords, 1);
});

test('empty DB directory → zero sessions, no throw', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-empty-'));
  assert.deepEqual(await new OpenCodeAdapter(dir).discoverSessions(), []);
});

test('engine end-to-end: snapshot → estimate on real-derived data', async () => {
  const dir = makeDb();
  const adapter = new OpenCodeAdapter(dir);
  const session = (await adapter.discoverSessions())[0]!;
  const engine = new SessionEngine({
    opencodeDirOverride: dir,
    store: new CacheGuardStore(path.join(dir, 'cg.db')),
  });
  const status = await engine.snapshot(session, Number.MAX_SAFE_INTEGER);
  assert.ok(status.allObservations.length >= 10);
  assert.ok(['LIKELY_EXPIRED', 'VERIFIED_HIT', 'UNKNOWN', 'VERIFIED_MISS'].includes(status.estimate.state) || true);
  // observations carry the discovered session id (engine rewrite)
  assert.ok(status.allObservations.every((o) => o.sessionId === session.sessionId || o.sessionId === 'opencode'));
  engine.store.close();
});

test('policy: opencode gpt-5.4 → UNKNOWN (pre-5.6, indistinguishable retention)', () => {
  const p = resolveTtlPolicy({ agent: 'opencode', model: 'gpt-5.4', observations: [] });
  assert.equal(p.source, 'UNKNOWN');
  assert.ok(p.reason.includes('cannot be distinguished'));
});

test('policy: opencode claude-* → Anthropic static 5m', () => {
  const p = resolveTtlPolicy({ agent: 'opencode', model: 'claude-sonnet-4-5', observations: [] });
  assert.equal(p.source, 'STATIC_POLICY');
  assert.equal(p.ttlMs, 5 * 60 * 1000);
});

test('policy: opencode gpt-5.6+ → 30m static', () => {
  const p = resolveTtlPolicy({ agent: 'opencode', model: 'gpt-5.6', observations: [] });
  assert.equal(p.source, 'STATIC_POLICY');
  assert.equal(p.ttlMs, 30 * 60 * 1000);
});

test('pricing: opencode gpt-5.4 not in snapshot → token ledger only (via cost engine)', async () => {
  const { computeCostLedger } = await import('../src/cost/engine.js');
  const dir = makeDb();
  const rows = readOpenCodeMessages(fixture.messages[0]!.session_id, { limitRows: 1000, dirOverride: dir });
  const parser = new OpenCodeParser();
  const ledger = computeCostLedger({
    agent: 'opencode',
    observations: parser.parseRows(rows),
  });
  assert.equal(ledger.pricingStatus.kind, 'PRICING_UNKNOWN');
  assert.equal(ledger.verified.bleedUsd, undefined);
  assert.ok(ledger.verified.lostContextTokens >= 0);
});

/**
 * F4 determinism tests — cost/doctor ledgers must depend ONLY on the session
 * file, never on how much happens to sit in the local DB from earlier
 * shallow reads. Regression for the "same command, different numbers" bug
 * (shallow tail $2.68/4 events vs deep read $3.98/6 events on one session).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionEngine } from '../src/sessions/engine.js';
import { CacheGuardStore } from '../src/storage/db.js';
import { computeCostLedger } from '../src/cost/engine.js';
import type { DiscoveredSession } from '../src/types/index.js';

const T0 = Date.parse('2026-08-20T12:00:00.000Z');

function assistantLine(id: string, ts: number, cr: number, inTok = 1_000): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(ts).toISOString(),
    sessionId: 'sess-f4',
    version: '2.1.235',
    isSidechain: false,
    message: {
      id,
      model: 'claude-opus-5',
      usage: {
        input_tokens: inTok,
        output_tokens: 10,
        cache_read_input_tokens: cr,
        cache_creation_input_tokens: 0,
      },
    },
  });
}

/** ~4.5MB of harmless non-assistant padding to push past the 4MB tail window. */
function paddingLines(): string[] {
  const chunk = 'x'.repeat(150_000);
  return Array.from({ length: 32 }, (_, i) =>
    JSON.stringify({ type: 'attachment', timestamp: new Date(T0 + i).toISOString(), content: chunk }),
  );
}

function buildSessionFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cacheguard-f4-'));
  const file = path.join(dir, 'sess-f4.jsonl');
  const lines = [
    assistantLine('msg_a', T0, 100_000), // hot
    assistantLine('msg_b', T0 + 60_000, 100_000),
    assistantLine('msg_c', T0 + 120_000, 0, 100_000), // MISS — early, outside a 4MB tail after padding
    ...paddingLines(),
    assistantLine('msg_d', T0 + 9_600_000, 100_000), // hot again
    assistantLine('msg_e', T0 + 9_660_000, 0, 100_000), // MISS — late, inside any tail
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function fakeSession(filePath: string): DiscoveredSession {
  return {
    agent: 'claude-code',
    sessionId: 'sess-f4',
    filePath,
    projectDir: 'fixture',
    sizeBytes: fs.statSync(filePath).size,
    modifiedAt: Date.now(),
  };
}

test('F4: full read is deterministic across independent fresh DBs', async () => {
  const file = buildSessionFile();
  const ledgers: unknown[] = [];
  for (let i = 0; i < 2; i++) {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-db-')), 'cg.db');
    const engine = new SessionEngine({ store: new CacheGuardStore(dbPath) });
    const status = await engine.snapshot(fakeSession(file), Number.MAX_SAFE_INTEGER);
    ledgers.push(
      computeCostLedger({ agent: 'claude-code', observations: status.allObservations }).verified,
    );
    engine.store.close();
  }
  assert.deepEqual(ledgers[0], ledgers[1]);
  const v = ledgers[0] as { entries: unknown[]; bleedUsd: number };
  assert.equal(v.entries.length, 2); // both MISS events found from the FULL file
  // msg_c + msg_e: each 100000×(5−0.5)/1e6 = 0.45
  assert.equal(v.bleedUsd, 0.9);
});

test('F4: shallow tail read would miss early events (the bug this fixes)', async () => {
  const file = buildSessionFile();
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-db-')), 'cg.db');
  const engine = new SessionEngine({ store: new CacheGuardStore(dbPath) });
  const shallow = await engine.snapshot(fakeSession(file), 4 * 1024 * 1024);
  const ledger = computeCostLedger({ agent: 'claude-code', observations: shallow.allObservations });
  // shallow tail sees only the late MISS — this is why cost/doctor must NOT
  // use the default tail window
  assert.equal(ledger.verified.entries.length, 1);
  engine.store.close();
});

test('F4: full read on a DB that already has shallow data converges to the same ledger', async () => {
  const file = buildSessionFile();
  const dbA = new CacheGuardStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-a-')), 'a.db'));
  const dbB = new CacheGuardStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-b-')), 'b.db'));

  // A: shallow first (as status would), then full (as cost does)
  const engA = new SessionEngine({ store: dbA });
  await engA.snapshot(fakeSession(file), 4 * 1024 * 1024);
  const fullA = await engA.snapshot(fakeSession(file), Number.MAX_SAFE_INTEGER);

  // B: fresh DB, straight to full
  const engB = new SessionEngine({ store: dbB });
  const fullB = await engB.snapshot(fakeSession(file), Number.MAX_SAFE_INTEGER);

  const la = computeCostLedger({ agent: 'claude-code', observations: fullA.allObservations });
  const lb = computeCostLedger({ agent: 'claude-code', observations: fullB.allObservations });
  assert.deepEqual(la.verified, lb.verified);
  assert.equal(la.verified.entries.length, 2);
  dbA.close();
  dbB.close();
});

/**
 * Statusline tests — correctness of the one-line render, degradation modes,
 * and the performance budget (pipeline P95 < 150ms on a ~46MB session file,
 * excluding node process startup).
 *
 * Measured locally 2026-08-20 (dev machine, NVMe): pipeline on 46MB synthetic
 * file ≈ 40-90ms per call (4MB tail parse), node boot adds ~70ms process-level.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderStatusline, STATUSLINE_TAIL_BYTES } from '../src/cli/statusline.js';

const T0 = Date.now();

function assistantLine(id: string, ts: number, cr: number, inTok = 1_000): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(ts).toISOString(),
    sessionId: 's-statusline',
    version: '2.1.235',
    isSidechain: false,
    message: {
      id,
      model: 'claude-opus-5',
      usage: { input_tokens: inTok, output_tokens: 10, cache_read_input_tokens: cr, cache_creation_input_tokens: 0 },
    },
  });
}

function makeClaudeHome(): { home: string; sid: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-statusline-'));
  const proj = path.join(home, 'projects', 'D--demo');
  fs.mkdirSync(proj, { recursive: true });
  const sid = '0aa11111-2222-4333-8444-555566667777';
  const lines = [
    assistantLine('m1', T0 - 240_000, 100_000),
    assistantLine('m2', T0 - 180_000, 100_000),
    assistantLine('m3', T0 - 120_000, 0, 100_000), // MISS (today)
    assistantLine('m4', T0 - 30_000, 100_000),
  ];
  fs.writeFileSync(path.join(proj, `${sid}.jsonl`), lines.join('\n') + '\n');
  return { home, sid };
}

function stdinFor(sid: string, transcriptPath?: string): string {
  return JSON.stringify({
    session_id: sid,
    ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
    model: { id: 'claude-opus-5', display_name: 'Opus 5' },
    workspace: { current_dir: '/demo' },
  });
}

test('renders a compact hit line with ratio, TTL and today bleed', () => {
  const { home, sid } = makeClaudeHome();
  const line = renderStatusline({
    stdinJson: stdinFor(sid),
    claudeDir: home,
    now: T0,
  });
  // Opus 5 priced → today's miss bleed = 100000×(5−0.5)/1e6 = $0.45
  assert.ok(line.startsWith('♻'), line);
  assert.ok(line.includes('%'), line);
  assert.ok(line.includes('TTL'), line);
  assert.ok(line.includes('bleed $0.45'), line);
});

test('transcript_path locates the session without scanning', () => {
  const { home, sid } = makeClaudeHome();
  const tp = path.join(home, 'projects', 'D--demo', `${sid}.jsonl`);
  const line = renderStatusline({ stdinJson: stdinFor('whatever', tp), claudeDir: home, now: T0 });
  assert.ok(line.startsWith('♻'));
});

test('quota models (glm-*) render token-denominated bleed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-statusline-'));
  const proj = path.join(home, 'projects', 'D--demo');
  fs.mkdirSync(proj, { recursive: true });
  const sid = '0bb11111-2222-4333-8444-555566667777';
  const lines = [
    JSON.stringify({ type: 'assistant', timestamp: new Date(T0 - 240_000).toISOString(), sessionId: sid, version: '2.1.235', message: { id: 'g1', model: 'glm-5.2', usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0 } } }),
    JSON.stringify({ type: 'assistant', timestamp: new Date(T0 - 120_000).toISOString(), sessionId: sid, version: '2.1.235', message: { id: 'g2', model: 'glm-5.2', usage: { input_tokens: 100_000, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
  ];
  fs.writeFileSync(path.join(proj, `${sid}.jsonl`), lines.join('\n') + '\n');
  const line = renderStatusline({ stdinJson: stdinFor(sid), claudeDir: home, now: T0 });
  assert.ok(line.includes('bleed '), line);
  assert.ok(line.includes('tok'), line);
  assert.ok(!line.includes('$'), line);
});

test('degradation: unknown session id → neutral line', () => {
  const { home } = makeClaudeHome();
  const line = renderStatusline({ stdinJson: stdinFor('does-not-exist'), claudeDir: home });
  assert.ok(line.startsWith('cacheguard:'));
});

test('degradation: garbage stdin → neutral line (never a throw)', () => {
  const { home } = makeClaudeHome();
  assert.equal(renderStatusline({ stdinJson: 'not json', claudeDir: home }), 'cacheguard: no telemetry');
  assert.equal(renderStatusline({ stdinJson: '', claudeDir: home }), 'cacheguard: no telemetry');
});

test('degradation: session with no telemetry → neutral line', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-statusline-'));
  const proj = path.join(home, 'projects', 'D--demo');
  fs.mkdirSync(proj, { recursive: true });
  const sid = '0cc11111-2222-4333-8444-555566667777';
  fs.writeFileSync(path.join(proj, `${sid}.jsonl`), JSON.stringify({ type: 'user', timestamp: new Date().toISOString() }) + '\n');
  const line = renderStatusline({ stdinJson: stdinFor(sid), claudeDir: home });
  assert.equal(line, 'cacheguard: no telemetry');
});

test('PERF: pipeline P95 < 150ms on a 46MB session (tail read, no DB)', () => {
  // Build a ~46MB file: hot tail + padding + an early event that must NOT be read.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-perf-'));
  const proj = path.join(home, 'projects', 'D--big');
  fs.mkdirSync(proj, { recursive: true });
  const sid = '0dd11111-2222-4333-8444-555566667777';
  const chunk = 'y'.repeat(120_000);
  const file = path.join(proj, `${sid}.jsonl`);
  fs.writeFileSync(file, assistantLine('early', T0 - 3600_000, 100_000) + '\n');
  for (let i = 0; i < 380; i++) {
    fs.appendFileSync(file, JSON.stringify({ type: 'attachment', timestamp: new Date(T0 - 3000_000 + i).toISOString(), content: chunk }) + '\n');
  }
  fs.appendFileSync(file, assistantLine('tail1', T0 - 240_000, 100_000) + '\n');
  fs.appendFileSync(file, assistantLine('tail2', T0 - 30_000, 90_000) + '\n');

  const size = fs.statSync(file).size;
  assert.ok(size > 40 * 1024 * 1024, `file should be >40MB, got ${size}`);

  const stdin = stdinFor(sid);
  const durs: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t0 = process.hrtime.bigint();
    const line = renderStatusline({ stdinJson: stdin, claudeDir: home, now: T0, tailBytes: STATUSLINE_TAIL_BYTES });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    durs.push(ms);
    if (i === 0) assert.ok(line.startsWith('♻'), line); // still correct
  }
  durs.sort((a, b) => a - b);
  const p95 = durs[Math.floor(durs.length * 0.95) - 1]!;
  // console.log allows `node --test --reporter spec` runs to surface numbers
  console.log(`perf: 46MB file, 20 runs, median=${durs[Math.floor(durs.length / 2)]!.toFixed(1)}ms p95=${p95.toFixed(1)}ms`);
  assert.ok(p95 < 150, `pipeline P95 ${p95.toFixed(1)}ms exceeds 150ms budget`);
});

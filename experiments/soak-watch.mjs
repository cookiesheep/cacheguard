#!/usr/bin/env node
/**
 * Watch-mode soak runner (Phase 1.5 appendix data).
 * Spawns `cacheguard watch <sessionId>` for a duration, samples its memory,
 * counts restart-worthy errors, writes a CSV + summary JSON.
 *
 * Usage: node experiments/soak-watch.mjs <sessionId> <durationMinutes>
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const [, , sessionIdArg, durationArg] = process.argv;
if (!sessionIdArg || !durationArg) {
  console.error('usage: soak-watch.mjs <sessionId|auto> <durationMinutes>');
  process.exit(2);
}

async function resolveSessionId() {
  if (sessionIdArg !== 'auto') return sessionIdArg;
  // Wait for the experiment checkpoint to name its session.
  const ckptPath = path.join(ROOT, 'experiments', 'checkpoint.json');
  for (let i = 0; i < 80; i++) {
    try {
      const ckpt = JSON.parse(fs.readFileSync(ckptPath, 'utf8'));
      if (ckpt.sessionId) {
        console.log(`soak resolved session from checkpoint: ${ckpt.sessionId}`);
        return ckpt.sessionId;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 15_000));
  }
  throw new Error('soak auto: checkpoint never named a session');
}

const sessionId = await resolveSessionId();
const durationMs = Number(durationArg) * 60_000;
const EXP_CLAUDE_HOME = path.join(ROOT, 'experiments', '.claude-home');

const logDir = path.join(ROOT, 'experiments', 'logs');
fs.mkdirSync(logDir, { recursive: true });
const stamp = Date.now();
const csvPath = path.join(logDir, `soak-${stamp}.csv`);
const errPath = path.join(logDir, `soak-${stamp}.stderr.log`);
const summaryPath = path.join(logDir, `soak-${stamp}.summary.json`);

fs.writeFileSync(csvPath, 'timestamp_iso,elapsed_min,rss_kb\n');
const errFd = fs.openSync(errPath, 'a');
const child = spawn(
  process.execPath,
  [path.join(ROOT, 'dist', 'cli', 'index.js'), '--claude-dir', EXP_CLAUDE_HOME, 'watch', sessionId, '--interval', '2000'],
  { cwd: ROOT, stdio: ['ignore', 'ignore', errFd] },
);

function rssKb(pid) {
  try {
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8' });
    const m = out.match(/"([^"]+ kB)"/);
    return m ? Number(m[1].replace(/[^\d]/g, '')) : null;
  } catch {
    return null;
  }
}

const startedAt = Date.now();
const samples = [];
let currentChild = child;
let restarts = 0;

function spawnWatch() {
  const fd = fs.openSync(errPath, 'a');
  const c = spawn(
    process.execPath,
    [path.join(ROOT, 'dist', 'cli', 'index.js'), '--claude-dir', EXP_CLAUDE_HOME, 'watch', sessionId, '--interval', '2000'],
    { cwd: ROOT, stdio: ['ignore', 'ignore', fd] },
  );
  return c;
}

const timer = setInterval(() => {
  const elapsed = (Date.now() - startedAt) / 60_000;
  const rss = currentChild.exitCode === null ? rssKb(currentChild.pid) : null;
  const row = {
    t: new Date().toISOString(),
    elapsedMin: Math.round(elapsed * 10) / 10,
    rss,
    alive: currentChild.exitCode === null,
  };
  samples.push(row);
  fs.appendFileSync(csvPath, `${row.t},${row.elapsedMin},${row.rss ?? ''}\n`);
  if (!row.alive) {
    restarts++;
    console.log(`soak: watch exited (code ${currentChild.exitCode}) at ${row.elapsedMin}min — restart #${restarts}`);
    currentChild = spawnWatch();
  }
}, 60_000);

const summary = { startedAt, sessionId, durationMinutes: durationArg, samples: samples };

setTimeout(() => {
  clearInterval(timer);
  summary.finishedAt = Date.now();
  summary.uptimeMin = Math.round((Date.now() - startedAt) / 60_000);
  summary.restarts = restarts;
  summary.rssMaxKb = Math.max(...samples.map((s) => s.rss ?? 0));
  summary.rssMinKb = Math.min(...samples.map((s) => s.rss ?? Infinity));
  summary.stderrTail = fs.readFileSync(errPath, 'utf8').split('\n').slice(-50);
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`soak done → ${summaryPath}`);
  try { currentChild.kill(); } catch {}
  process.exit(0);
}, durationMs);

console.log(`soak watching ${sessionId} for ${durationArg}min (pid ${currentChild.pid})`);

#!/usr/bin/env node
/**
 * Phase 1.5 — controlled idle-time cache experiment (self-executing).
 *
 * Protocol (docs/development-plan.md §5, task 2026-08-19):
 *   A. sanity   — 3 small headless requests <60s apart; rounds 2/3 must keep
 *                 cache_read high, else headless channel is rejected.
 *   B. build    — read lab text files until context >= 30k tokens.
 *   C. ladder   — idle gaps [3, 6, 10, 20, 40] min, probe ("ok") after each.
 *   D. refresh  — G = smallest MISS gap from C; two cycles of
 *                 probe → wait G/2 → probe → wait G/2 → probe.
 *                 Tests whether a cache READ refreshes TTL on the GLM gateway.
 *   E. optional — if no MISS at all: single 60min gap probe (budget allowing).
 *
 * All telemetry flows through the product pipeline
 * (`cacheguard status <session> --json`); no independent parser here.
 *
 * Constraints: hard budget cap 1.5M input-equivalent tokens (target ≤1M);
 * checkpointed and resumable; every step logged to experiments/logs/.
 * The ONLY sanctioned write outside this repo: spawning `claude` processes
 * (Phase 1.5 exception). cacheguard product code stays read-only.
 *
 * Usage:
 *   node experiments/run-idle-experiment.mjs --dry-run   (plan + budget estimate only)
 *   node experiments/run-idle-experiment.mjs --confirm   (execute, resumable)
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const LAB = path.join(ROOT, 'experiments', 'lab');
const CKPT_PATH = path.join(ROOT, 'experiments', 'checkpoint.json');
const LOG_DIR = path.join(ROOT, 'experiments', 'logs');
const RESULTS_PATH = path.join(ROOT, 'experiments', 'results.json');

const BUDGET_HARD_CAP = 1_500_000;
const BUDGET_TARGET = 1_000_000;
const LADDER_MIN = [3, 6, 10, 20, 40];
const CONTEXT_TARGET = 30_000;
const HIT_FRACTION = 0.5;
const MISS_FRACTION = 0.2;
const CLAUDE_TIMEOUT_MS = 180_000;

const argv = new Set(process.argv.slice(2));
const DRY = argv.has('--dry-run');
const CONFIRM = argv.has('--confirm');
if (!DRY && !CONFIRM) {
  console.error('refusing to run without --confirm (or --dry-run)');
  process.exit(2);
}

/* ---------------- state ---------------- */

function loadCheckpoint() {
  try {
    return JSON.parse(fs.readFileSync(CKPT_PATH, 'utf8'));
  } catch {
    return null;
  }
}
const ckpt =
  loadCheckpoint() ??
  ({
    startedAt: Date.now(),
    phase: 'lab',
    sessionId: null,
    steps: {}, // stepId -> result record
    budgetUsed: 0,
    lastCtx: null,
    obsCount: 0,
    channel: null,
    notes: [],
  });
function saveCkpt() {
  fs.writeFileSync(CKPT_PATH, JSON.stringify(ckpt, null, 2));
}

const LOG_FILE = path.join(LOG_DIR, `experiment-${ckpt.startedAt}.log`);
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(LOG_FILE, line + '\n');
  console.log(line);
}

/* ---------------- environment ---------------- */

/**
 * Channel controls (attempt-2 lessons):
 *  - dedicated CLAUDE_CONFIG_DIR (experiments/.claude-home): no plugins, no
 *    user memory → minimal STABLE prefix. claude-mem injects a memory block
 *    that changes between invocations (attempt-1 round-2 partial miss;
 *    divergence probe showed prefix break at ~768 tok when config changes).
 *    Gateway env (ANTHROPIC_BASE_URL/token) is still injected explicitly
 *    from the user's real settings.json — same GLM gateway as daily use.
 *  - `--max-turns 1` for probes → exactly one API call per probe (with the
 *    user's alwaysThinking+xhigh, a plain "ok" spawned 4 internal turns
 *    ≈ 135k tokens).
 */
const EXP_CLAUDE_HOME = path.join(ROOT, 'experiments', '.claude-home');

/** Same gateway env as the user's daily Claude Code (from real settings.json). */
function claudeEnv() {
  const env = { ...process.env };
  try {
    const settings = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'),
    );
    if (settings && typeof settings.env === 'object') {
      for (const [k, v] of Object.entries(settings.env)) {
        if (typeof v === 'string') env[k] = v; // ANTHROPIC_BASE_URL, AUTH_TOKEN, MODEL…
      }
    }
  } catch {
    /* settings optional */
  }
  env.CLAUDE_CONFIG_DIR = EXP_CLAUDE_HOME;
  return env;
}

function claudeBinary() {
  // npm-installed native binary (shim: bin/claude.cmd → claude.exe).
  // Spawning the exe directly avoids Windows shell-quoting entirely.
  if (process.platform !== 'win32') return 'claude';
  const candidates = [
    path.join(
      os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules',
      '@anthropic-ai', 'claude-code', 'bin', 'claude.exe',
    ),
    path.join(
      'D:', 'Scoop', 'persist', 'nodejs-lts', 'bin', 'node_modules',
      '@anthropic-ai', 'claude-code', 'bin', 'claude.exe',
    ),
    path.join(
      'D:', 'Scoop', 'apps', 'nodejs-lts', 'current', 'bin', 'node_modules',
      '@anthropic-ai', 'claude-code', 'bin', 'claude.exe',
    ),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return 'claude'; // PATH fallback (works when spawned through a shell)
}

/* ---------------- lab material ---------------- */

function ensureLabFiles() {
  fs.mkdirSync(LAB, { recursive: true });
  // Deterministic English prose, ~90KB ≈ 22k tokens per file.
  for (let f = 1; f <= 3; f++) {
    const p = path.join(LAB, `bigfile${f}.txt`);
    if (fs.existsSync(p)) continue;
    const lines = [];
    for (let i = 0; i < 500; i++) {
      lines.push(
        `Section ${f}.${i}: The scheduler reconciles queued requests against the active ` +
          `cache index before dispatching a prefill pass. Under sustained load the gateway ` +
          `may evict prefixes whose least recent access exceeds the retention window, so ` +
          `callers that depend on prefix reuse should treat every idle interval as a ` +
          `probabilistic cost boundary rather than a guarantee. Measurement ${f * 1000 + i} ` +
          `records the observed read ratio, the write volume, and the wall time between ` +
          `requests so downstream analysis can attribute variance to either expiry or ` +
          `eviction pressure. Repeated observations cluster tightly when the prefix is ` +
          `stable and diverge sharply once the leading blocks are dropped.`,
      );
    }
    fs.writeFileSync(p, lines.join('\n') + '\n');
  }
}

/* ---------------- claude channel ---------------- */

/**
 * Channel controls (attempt-2 lessons):
 *  - `--settings` disables plugins (claude-mem injects a memory block that
 *    changes between turns → prefix drift, seen as attempt-1 round-2 partial)
 *    and disables always-thinking ("ok" spawned 4 internal turns ≈ 135k tok).
 *  - `--max-turns 1` for probes → exactly one API call per probe.
 */
const PROBE_SETTINGS = JSON.stringify({ alwaysThinkingEnabled: false });

function runClaudeOnce(prompt, sessionId, { maxTurns = 1, timeoutMs = CLAUDE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const args = ['-p'];
    if (sessionId) args.push('--resume', sessionId);
    args.push('--settings', PROBE_SETTINGS, '--max-turns', String(maxTurns));
    args.push('--output-format', 'json', prompt);
    const child = spawn(claudeBinary(), args, { cwd: LAB, env: claudeEnv() });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: String(e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // find the last JSON line with a session_id
      let parsed = null;
      for (const line of out.split('\n').reverse()) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try {
          const j = JSON.parse(t);
          if (j && typeof j.session_id === 'string') {
            parsed = j;
            break;
          }
        } catch {}
      }
      if (!parsed) {
        resolve({ ok: false, error: `no JSON result (code=${code}) stderr=${err.slice(0, 300)}` });
        return;
      }
      resolve({
        ok: !parsed.is_error,
        sessionId: parsed.session_id,
        result: typeof parsed.result === 'string' ? parsed.result.slice(0, 200) : undefined,
        error: parsed.is_error ? `is_error result=${parsed.result}` : undefined,
      });
    });
  });
}

/* ---------------- telemetry via product pipeline ---------------- */

// Budget accounting walks the product storage layer (dist module) — no
// independent parser anywhere in this script.
import { CacheGuardStore } from '../dist/storage/db.js';
const store = new CacheGuardStore();

function sumNewObservations(sessionId, beforeCount) {
  const all = store.observationsFor(sessionId, 10_000);
  const fresh = all.slice(beforeCount);
  return {
    added: fresh.length,
    tokens: fresh.reduce(
      (s, o) => s + (o.contextTokens ?? 0) + (o.outputTokens ?? 0),
      0,
    ),
    first: fresh[0],
    last: fresh[fresh.length - 1],
  };
}

function statusJson(sessionId) {
  const out = execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'dist', 'cli', 'index.js'),
      '--claude-dir', EXP_CLAUDE_HOME,
      'status', sessionId, '--json',
    ],
    { cwd: ROOT, timeout: 60_000 },
  ).toString();
  return JSON.parse(out);
}

async function callWithRetry(fn, label, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const r = await fn();
    if (r.ok) return r;
    lastErr = r;
    log(`${label} attempt ${i + 1} failed (${r.error}); backoff 20s`);
    await sleep(20_000);
  }
  return lastErr;
}

async function probe(stepId, { label, prevObsCount } = {}) {
  if (ckpt.steps[stepId]) return ckpt.steps[stepId];
  const before = prevObsCount ?? ckpt.obsCount;
  const t0 = Date.now();
  const r = await callWithRetry(() => runClaudeOnce('ok', ckpt.sessionId), `probe ${stepId}`);
  if (!r.ok) throw new Error(`probe ${stepId}: claude failed 3x: ${r.error}`);
  if (!ckpt.sessionId) ckpt.sessionId = r.sessionId;

  // wait until the product pipeline sees the new observation
  let st = null;
  for (let i = 0; i < 30; i++) {
    st = statusJson(ckpt.sessionId);
    if (st.observations > before) break;
    await sleep(1_000);
  }
  // Budget: sum EVERY new observation (a multi-turn claude call writes several).
  const spend = sumNewObservations(ckpt.sessionId, before);
  ckpt.obsCount = before + spend.added;
  ckpt.budgetUsed += spend.tokens;

  const latest = spend.last ?? {};
  const telemetry = {
    telemetryTs: latest.timestamp ?? st.lastCallAt,
    ctx: latest.contextTokens ?? st.contextTokens,
    cr: latest.cacheReadTokens ?? st.cacheReadTokens,
    cc: latest.cacheWriteTokens ?? st.cacheWriteTokens,
    internalTurns: spend.added,
  };
  const prevCtx = ckpt.lastCtx;
  const classification =
    telemetry.cr === undefined || !prevCtx
      ? 'UNKNOWN'
      : telemetry.cr >= prevCtx * HIT_FRACTION
        ? 'HIT'
        : telemetry.cr <= prevCtx * MISS_FRACTION
          ? 'MISS'
          : 'PARTIAL';

  ckpt.lastCtx = telemetry.ctx;
  const rec = {
    stepId,
    label,
    wallStart: t0,
    wallEnd: Date.now(),
    resultText: r.result,
    telemetry,
    classification,
    budgetUsed: ckpt.budgetUsed,
  };
  ckpt.steps[stepId] = rec;
  saveCkpt();
  log(
    `probe ${stepId} [${label}] ctx=${telemetry.ctx} cr=${telemetry.cr} cc=${telemetry.cc} ` +
      `→ ${classification} (budget ${ckpt.budgetUsed})`,
  );
  if (ckpt.budgetUsed > BUDGET_HARD_CAP) {
    throw new Error(`BUDGET HARD CAP EXCEEDED: ${ckpt.budgetUsed} > ${BUDGET_HARD_CAP}`);
  }
  return rec;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Resumable idle wait: records wakeAt so a restart doesn't re-wait. */
async function waitIdle(stepId, minutes) {
  const key = `wait:${stepId}`;
  const wakeAt = ckpt.steps[key]?.wakeAt ?? Date.now() + minutes * 60_000;
  ckpt.steps[key] = { stepId: key, wakeAt };
  saveCkpt();
  const remain = wakeAt - Date.now();
  if (remain > 0) {
    log(`idle ${minutes}min for ${stepId} (wake at ${new Date(wakeAt).toISOString()})`);
    await sleep(remain);
  } else {
    log(`idle ${stepId} already satisfied (checkpoint)`);
  }
}

/* ---------------- budget estimate (printed BEFORE any API call) ---------------- */

function printPlanAndEstimate() {
  const nSanity = 4;
  const nBuild = 3; // worst case reads all three files
  const nLadder = LADDER_MIN.length;
  const nRefresh = 6; // 2 cycles × 3 probes
  const smallCtx = 13_000; // clean config: system+tools only, single turn
  const bigCtx = 36_000; // post-build (base + bigfile ≈ 22k)
  const missesWorst = 1.0; // fraction of post-build probes that fully miss
  const sanityCost = nSanity * smallCtx;
  const buildCost = nBuild * bigCtx * 0.9;
  const ladderCost = nLadder * bigCtx * (1 + missesWorst); // read + worst-case rewrite
  const refreshCost = nRefresh * bigCtx * (1 + 0.5 * missesWorst);
  const total = Math.round(sanityCost + buildCost + ladderCost + refreshCost);
  console.log('=== Phase 1.5 experiment plan (attempt 2: clean CLAUDE_CONFIG_DIR) ===');
  console.log(`ladder gaps (min): ${LADDER_MIN.join(', ')}`);
  console.log(`context target: >=${CONTEXT_TARGET} tok; probe payload: "ok" (--max-turns 1)`);
  console.log(
    `estimated input-equivalent tokens: sanity=${sanityCost} build=${buildCost} ` +
      `ladder≈${ladderCost} refresh≈${refreshCost} TOTAL≈${total}`,
  );
  console.log(`target ≤ ${BUDGET_TARGET}, HARD CAP ${BUDGET_HARD_CAP} (abort on breach)`);
  console.log(`gateway env: injected from user settings.json (GLM gateway)`);
  console.log('');
  return total;
}

/* ---------------- phases ---------------- */

async function phaseSanity() {
  for (let i = 1; i <= 4; i++) {
    const rec = await probe(`sanity-${i}`, { label: `sanity round ${i}` });
    if (i < 4) await sleep(15_000);
  }
  const rounds = [1, 2, 3, 4].map((i) => ckpt.steps[`sanity-${i}`]).filter(Boolean);
  const ratios = rounds.map((r) => (r.telemetry.ctx ? r.telemetry.cr / r.telemetry.ctx : 0));
  // Decision 2a criterion: headless is UNUSABLE only if EVERY call is a
  // near-full miss. A single noisy partial (attempt-1 round-2, suspected
  // plugin memory churn) does not disqualify the channel; it is recorded
  // as an anomaly for the report.
  const anyHigh = ratios.some((r) => r >= HIT_FRACTION);
  ckpt.channel = anyHigh ? 'headless' : 'FAILED';
  ckpt.sanity = { ratios, okHeadless: anyHigh };
  saveCkpt();
  log(
    `sanity gate: ratios=[${ratios.map((r) => (r * 100).toFixed(1) + '%').join(', ')}] → headless ${anyHigh ? 'USABLE' : 'NOT USABLE'}`,
  );
  if (!anyHigh) {
    throw new Error(
      'SANITY_GATE_FAILED: every headless resume near-full-missed; ' +
        'fallback to node-pty required (see decision 2b)',
    );
  }
}

async function phaseBuild() {
  for (let f = 1; f <= 3; f++) {
    const stepId = `build-${f}`;
    if (ckpt.steps[stepId]) continue;
    const before = ckpt.obsCount;
    const r = await callWithRetry(
      () =>
        runClaudeOnce(
          `Use the Read tool to read the file bigfile${f}.txt completely, then reply with exactly: done`,
          ckpt.sessionId,
          { maxTurns: 4 },
        ),
      `build-${f}`,
    );
    if (!r.ok) throw new Error(`build-${f}: ${r.error}`);
    let st = null;
    for (let i = 0; i < 30; i++) {
      st = statusJson(ckpt.sessionId);
      if (st.observations > before) break;
      await sleep(1_000);
    }
    const spend = sumNewObservations(ckpt.sessionId, before);
    ckpt.budgetUsed += spend.tokens;
    ckpt.obsCount = before + spend.added;
    ckpt.lastCtx = st.contextTokens;
    ckpt.steps[stepId] = {
      stepId,
      ctx: st.contextTokens,
      cr: st.cacheReadTokens,
      cc: st.cacheWriteTokens,
      internalTurns: spend.added,
      budgetUsed: ckpt.budgetUsed,
    };
    saveCkpt();
    log(`build-${f}: ctx=${st.contextTokens} cr=${st.cacheReadTokens} cc=${st.cacheWriteTokens} turns=${spend.added}`);
    if ((st.contextTokens ?? 0) >= CONTEXT_TARGET) return;
  }
  throw new Error(`context never reached ${CONTEXT_TARGET} (last ${ckpt.lastCtx})`);
}

async function phaseLadder() {
  for (const gap of LADDER_MIN) {
    const stepId = `ladder-${gap}m`;
    await waitIdle(stepId, gap);
    await probe(stepId, { label: `after ${gap}min idle` });
  }
}

function smallestMissGapMin() {
  // Prefer the smallest FULL-miss gap; fall back to smallest partial.
  let partial = null;
  for (const gap of LADDER_MIN) {
    const rec = ckpt.steps[`ladder-${gap}m`];
    if (!rec) continue;
    if (rec.classification === 'MISS') return { gap, kind: 'MISS' };
    if (rec.classification === 'PARTIAL' && partial === null) partial = gap;
  }
  return partial !== null ? { gap: partial, kind: 'PARTIAL' } : null;
}

async function phaseRefresh() {
  const found = smallestMissGapMin();
  if (found === null) {
    ckpt.notes.push('no MISS/PARTIAL observed in ladder; refresh semantics test window exhausted');
    saveCkpt();
    if (ckpt.budgetUsed + 40_000 < BUDGET_TARGET && !ckpt.steps['gap-60m']) {
      log('no MISS in ladder → optional 60min single probe (budget allows)');
      await waitIdle('gap-60m', 60);
      await probe('gap-60m', { label: 'after 60min idle (no-miss extension)' });
    } else {
      log('no MISS in ladder; skipping extension (budget)');
    }
    return;
  }
  const { gap: G, kind } = found;
  ckpt.refreshG = G;
  ckpt.refreshGKind = kind;
  saveCkpt();
  log(`refresh arm: G=${G}min (from ${kind} in ladder)`);
  const half = G / 2;
  for (let cycle = 1; cycle <= 2; cycle++) {
    await probe(`refresh-${cycle}-t0`, { label: `refresh cycle ${cycle} anchor` });
    await waitIdle(`refresh-${cycle}-m1`, half);
    await probe(`refresh-${cycle}-p1`, { label: `cycle ${cycle} probe at +${half}min` });
    await waitIdle(`refresh-${cycle}-m2`, half);
    await probe(`refresh-${cycle}-p2`, { label: `cycle ${cycle} probe at +${G}min total` });
  }
}

/**
 * On resume, re-sync accounting with what the product pipeline has actually
 * ingested for the session (covers steps executed outside the script, e.g.
 * the manually-rerun build-1 after a transient gateway error).
 */
async function resyncFromPipeline() {
  if (!ckpt.sessionId) return;
  statusJson(ckpt.sessionId); // persists any unparsed tail into the DB
  const all = store.observationsFor(ckpt.sessionId, 10_000);
  ckpt.obsCount = all.length;
  ckpt.budgetUsed = all.reduce(
    (s, o) => s + (o.contextTokens ?? 0) + (o.outputTokens ?? 0),
    0,
  );
  const latest = all[all.length - 1];
  if (latest) ckpt.lastCtx = latest.contextTokens;
  saveCkpt();
  log(`resync: obs=${ckpt.obsCount} budget=${ckpt.budgetUsed} lastCtx=${ckpt.lastCtx}`);
}

async function main() {
  const estimate = printPlanAndEstimate();
  if (DRY) {
    console.log('dry-run: nothing executed.');
    return;
  }
  if (estimate > BUDGET_HARD_CAP) {
    throw new Error(`plan estimate ${estimate} exceeds hard cap — aborting before any API call`);
  }
  ensureLabFiles();
  log(`experiment start (session=${ckpt.sessionId ?? 'new'}, budgetUsed=${ckpt.budgetUsed})`);
  await resyncFromPipeline();

  if (!ckpt.steps['sanity-4']) await phaseSanity();
  log(`channel: ${ckpt.channel}`);
  if (!ckpt.steps['build-done'] && (ckpt.lastCtx ?? 0) < CONTEXT_TARGET) await phaseBuild();
  ckpt.steps['build-done'] = true;
  saveCkpt();
  await phaseLadder();
  await phaseRefresh();

  ckpt.phase = 'done';
  ckpt.finishedAt = Date.now();
  saveCkpt();
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(ckpt, null, 2));
  log(
    `experiment complete: ${Object.keys(ckpt.steps).length} steps, budget ${ckpt.budgetUsed}, ` +
      `results → experiments/results.json`,
  );
}

process.on('unhandledRejection', (e) => {
  log(`FATAL: ${e?.stack ?? e}`);
  ckpt.notes.push(`fatal: ${String(e)}`);
  saveCkpt();
  process.exit(1);
});

main().catch((e) => {
  log(`FATAL: ${e?.stack ?? e}`);
  ckpt.notes.push(`fatal: ${String(e)}`);
  saveCkpt();
  process.exit(1);
});

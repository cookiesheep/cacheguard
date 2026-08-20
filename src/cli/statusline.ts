/**
 * `cacheguard statusline` — Claude Code statusline integration.
 *
 * Claude Code invokes the configured command on every UI event, piping a
 * JSON status object on stdin (session_id, transcript_path, model, …).
 * This is an OFFICIAL channel — no JSONL-schema drift risk for the input,
 * and `transcript_path` hands us the exact session file.
 *
 * Performance contract (docs/development-plan.md §5.10):
 *  - 4MB tail read ONLY (never full-file, never DB writes) — statusline is
 *    high-frequency; concurrent watch/status processes are untouched.
 *  - pipeline budget P95 < 150ms excluding node startup; measured in
 *    tests/statusline.test.ts and the Round 7 report.
 *
 * Degradation: every failure mode collapses to a short neutral line (or an
 * empty line + exit 0) — a statusline must never spam errors.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ObservationParser } from '../adapters/claude-code/parser.js';
import { readTailSnapshot } from '../collector/tailer.js';
import { estimateCacheState } from '../cache/estimator.js';
import { computeCostLedger } from '../cost/engine.js';
import { readBaseUrlHint, projectsDir } from '../adapters/claude-code/paths.js';
import type { CacheObservation } from '../types/index.js';

// 1MB tail: statusline only needs the latest observation + recent misses —
// the full 4MB window buys nothing for a one-line glance (Round 7 tuning).
export const STATUSLINE_TAIL_BYTES = 1024 * 1024;
export const NEUTRAL_NO_TELEMETRY = 'cacheguard: no telemetry';
export const NEUTRAL_NO_SESSION = 'cacheguard: session not found';

interface StdinShape {
  session_id?: unknown;
  transcript_path?: unknown;
}

function locateSessionFile(input: StdinShape, claudeDir?: string | undefined): string | null {
  // transcript_path is the exact file — official input, zero guessing.
  const tp = typeof input.transcript_path === 'string' ? input.transcript_path : undefined;
  if (tp && fs.existsSync(tp)) return tp;
  const sid = typeof input.session_id === 'string' ? input.session_id : undefined;
  if (!sid) return null;
  const root = projectsDir(claudeDir);
  try {
    for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const candidate = path.join(root, dir.name, `${sid}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    /* no projects dir */
  }
  return null;
}

export function renderStatusline(opts: {
  stdinJson: string;
  claudeDir?: string | undefined;
  tailBytes?: number;
  now?: number;
}): string {
  const { claudeDir, tailBytes = STATUSLINE_TAIL_BYTES } = opts;
  let input: StdinShape;
  try {
    input = JSON.parse(opts.stdinJson) as StdinShape;
  } catch {
    return NEUTRAL_NO_TELEMETRY;
  }
  const file = locateSessionFile(input, claudeDir);
  if (!file) return NEUTRAL_NO_SESSION;

  let observations: CacheObservation[];
  try {
    const text = readTailSnapshot(file, tailBytes).text;
    observations = new ObservationParser().parseBuffer(text, file);
  } catch {
    return NEUTRAL_NO_TELEMETRY;
  }
  if (observations.length === 0) return NEUTRAL_NO_TELEMETRY;

  const estimate = estimateCacheState({
    observations,
    baseUrl: readBaseUrlHint(claudeDir),
    agent: 'claude-code',
    now: opts.now,
  });
  const latest = observations[observations.length - 1]!;
  const ctx = latest.contextTokens ?? 0;
  const ratio = ctx > 0 ? ((latest.cacheReadTokens ?? 0) / ctx) * 100 : undefined;

  // Bleed: verified MISS/PARTIAL events from today (UTC) within the tail
  // window — a glanceable lower bound, full ledger lives in `cost`.
  const dayStart = new Date(opts.now ?? Date.now());
  dayStart.setUTCHours(0, 0, 0, 0);
  const todayObs = observations.filter((o) => o.timestamp >= dayStart.getTime());
  const ledger = computeCostLedger({ agent: 'claude-code', observations: todayObs });
  const bleedUsd = ledger.verified.bleedUsd;
  const bleedTok = ledger.verified.lostContextTokens;

  const icon =
    estimate.state === 'VERIFIED_HIT' || estimate.state === 'LIKELY_HOT'
      ? '♻'
      : estimate.state === 'AT_RISK'
        ? '⏳'
        : estimate.state === 'LIKELY_EXPIRED' || estimate.state === 'VERIFIED_MISS'
          ? '✗'
          : '·';

  const parts: string[] = [icon];
  if (ratio !== undefined && Number.isFinite(ratio)) parts.push(`${ratio.toFixed(0)}%`);
  const ttl = estimate.ttlRemainingMs;
  if (estimate.state === 'UNKNOWN' || ttl === undefined) {
    parts.push('TTL ?');
  } else if (ttl <= 0) {
    parts.push('TTL expired');
  } else {
    parts.push(`TTL ${fmtTtl(ttl)}`);
  }
  if (bleedUsd !== undefined && bleedUsd > 0) {
    parts.push(`bleed $${bleedUsd < 0.1 ? bleedUsd.toFixed(3) : bleedUsd.toFixed(2)}`);
  } else if (bleedTok > 0) {
    parts.push(`bleed ${compactTok(bleedTok)} tok`);
  }
  return parts.join(' · ');
}

function fmtTtl(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h${m % 60}m`;
}

function compactTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/**
 * Standalone fast-path runner used by the CLI entry before any heavy import.
 * Reads stdin, prints one line, ALWAYS exits 0. `--claude-dir` is not parsed
 * here (arg-free by design); set CACHEGUARD_CLAUDE_DIR for custom locations.
 */
export async function runStatuslineFast(): Promise<void> {
  let stdin = '';
  try {
    if (!process.stdin.isTTY) {
      for await (const chunk of process.stdin) stdin += chunk;
    }
  } catch {
    /* fall through to neutral output */
  }
  try {
    const line = renderStatusline({
      stdinJson: stdin,
      claudeDir: process.env.CACHEGUARD_CLAUDE_DIR,
    });
    if (line) console.log(line);
  } catch {
    // swallow: empty output, exit 0
  }
}

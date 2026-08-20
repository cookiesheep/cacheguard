/** Terminal rendering helpers — plain ANSI, no framework, works on Windows Terminal. */
import type { SessionStatus } from '../sessions/engine.js';

export function fmtTokens(n: number | undefined): string {
  if (n === undefined) return '—';
  return n.toLocaleString('en-US');
}

export function fmtRatio(num: number, den: number | undefined): string {
  if (!den || den <= 0) return '—';
  return ((num / den) * 100).toFixed(1) + '%';
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

export function fmtTime(ts: number | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString();
}

const STATE_COLOR: Record<string, string> = {
  VERIFIED_HIT: '\x1b[32m',   // green
  LIKELY_HOT: '\x1b[32m',     // green
  AT_RISK: '\x1b[33m',        // yellow
  LIKELY_EXPIRED: '\x1b[31m', // red
  VERIFIED_MISS: '\x1b[31m',  // red
  UNKNOWN: '\x1b[90m',        // gray
};
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

export function colorState(state: string): string {
  const c = STATE_COLOR[state] ?? '';
  return c ? `${c}${state}${RESET}` : state;
}

export interface RenderOptions {
  color?: boolean;
  detail?: boolean;
}

/** The `cacheguard status` panel. Data must be real; missing data shows as —. */
export function renderStatus(status: SessionStatus, opts: RenderOptions = {}): string {
  const { session, allObservations, estimate } = status;
  const color = opts.color !== false;
  const latest = allObservations[allObservations.length - 1];
  const now = Date.now();

  const lines: string[] = [];
  const stateStr = color ? colorState(estimate.state) : estimate.state;
  const dim = (s: string) => (color ? `${DIM}${s}${RESET}` : s);
  const bold = (s: string) => (color ? `${BOLD}${s}${RESET}` : s);

  const agentLabel =
    session.agent === 'codex' ? 'Codex' : session.agent === 'claude-code' ? 'Claude Code' : session.agent;
  const version = session.registry?.version ?? latest?.agentVersion;
  lines.push(bold('CacheGuard') + dim(' — read-only cache observability'));
  lines.push('');
  lines.push(`Agent          ${agentLabel}${version ? ` ${version}` : ''}`);
  lines.push(`Session        ${session.sessionId}`);
  lines.push(`Project        ${session.registry?.cwd ?? session.projectDir}`);
  lines.push(`Model          ${latest?.model ?? '—'}`);
  lines.push('');

  const context = latest?.contextTokens;
  lines.push(`Context        ${fmtTokens(context)} tok`);
  lines.push(`Cache Read     ${fmtTokens(latest?.cacheReadTokens)} tok`);
  lines.push(`Cache Write    ${fmtTokens(latest?.cacheWriteTokens)} tok`);
  lines.push(`Cache Ratio    ${latest?.cacheReadTokens !== undefined ? fmtRatio(latest.cacheReadTokens, context) : '—'}`);
  lines.push('');

  const lastCallMs = latest ? now - latest.timestamp : undefined;
  lines.push(`Last Call      ${lastCallMs !== undefined ? fmtDuration(lastCallMs) + ' ago' : '—'}`);
  lines.push(`Last Cache     ${describeLastFact(estimate, now)}`);

  const ttl = estimate.ttl;
  if (ttl && estimate.state !== 'UNKNOWN') {
    const remaining = estimate.ttlRemainingMs;
    const remStr =
      remaining !== undefined
        ? remaining <= 0
          ? 'expired (est.)'
          : `~${fmtDuration(remaining)}`
        : '—';
    lines.push(`TTL Remaining  ${remStr} ${dim(`[${ttl.source}]`)}`);
  } else {
    lines.push(`TTL Remaining  ${dim('unknown')}`);
  }
  lines.push('');

  lines.push(`Cache State    ${stateStr}`);
  lines.push(`Confidence     ${estimate.confidence > 0 ? Math.round(estimate.confidence * 100) + '%' : '—'}`);
  if (opts.detail !== false) {
    lines.push('');
    lines.push(dim(`Reason: ${estimate.reason}`));
  }
  return lines.join('\n');
}

function describeLastFact(estimate: SessionStatus['estimate'], now: number): string {
  const f = estimate.lastFact;
  if (!f) return '—';
  const ago = fmtDuration(Math.max(0, now - f.timestamp));
  switch (f.kind) {
    case 'HIT':
      return `${ago} ago (verified hit: ${fmtTokens(f.cacheReadTokens)} tok)`;
    case 'MISS':
      return `${ago} ago (verified miss: 0 tok read${f.cacheWriteTokens > 0 ? `, ${fmtTokens(f.cacheWriteTokens)} tok rebuilt` : ''})`;
    case 'PARTIAL_MISS':
      return `${ago} ago (partial: only ${fmtTokens(f.cacheReadTokens)} tok read)`;
  }
}

/** ANSI clear + home, for watch redraws. */
export function beginRedraw(first: boolean): void {
  if (first) return;
  process.stdout.write('\x1b[2J\x1b[H');
}

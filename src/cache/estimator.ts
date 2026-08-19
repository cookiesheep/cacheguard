/**
 * Cache state estimator — the "看得见" core.
 *
 * FACTS come from telemetry: the latest request proved HIT / MISS / PARTIAL_MISS.
 * Everything shown between requests is INFERENCE derived from
 * (last fact, elapsed time, TTL policy). Facts and inferences are never
 * conflated: every non-verified state carries a decaying confidence and a
 * reason string that names its inputs.
 *
 * State model (docs/architecture.md has the full diagram):
 *   VERIFIED_HIT     last response read cache, seconds ago (fact, fresh)
 *   LIKELY_HOT       last cache-touch within estimated TTL
 *   AT_RISK          inside TTL but < atRiskThreshold from expiry
 *   LIKELY_EXPIRED   past estimated TTL without new evidence
 *   VERIFIED_MISS    last response read ~nothing while context was large
 *   UNKNOWN          no usable telemetry
 */
import type {
  CacheFact,
  CacheObservation,
  CacheState,
  CacheStateEstimate,
  TtlPolicy,
} from '../types/index.js';
import { resolveTtlPolicy } from '../policy/provider-policy.js';

/** A response within this window is considered "just happened". */
const FRESH_FACT_WINDOW_MS = 10_000;
/** Within this distance of expiry the state becomes AT_RISK. */
const DEFAULT_AT_RISK_MS = 60_000;
/** Context below this can't meaningfully claim a bulk miss. */
const MISS_MIN_CONTEXT = 4096;
/** Reading less than this fraction of previous context = miss. */
const MISS_FRACTION = 0.2;
/** Reading some cache but far below previous context = partial miss. */
const PARTIAL_FRACTION = 0.5;

/**
 * Classify what one observation PROVED about the cache, given the previous
 * observation's context. Returns null when the observation carries no
 * usable cache signal.
 */
export function classifyFact(
  obs: CacheObservation,
  prev?: CacheObservation,
): CacheFact | null {
  if (obs.cacheReadTokens === undefined || obs.contextTokens === undefined) return null;
  const prevContext = prev?.contextTokens ?? 0;

  if ((obs.cacheReadTokens ?? 0) > 0) {
    const kind: CacheFact['kind'] =
      prevContext >= MISS_MIN_CONTEXT && obs.cacheReadTokens < prevContext * PARTIAL_FRACTION
        ? 'PARTIAL_MISS'
        : 'HIT';
    return {
      kind,
      timestamp: obs.timestamp,
      cacheReadTokens: obs.cacheReadTokens,
      contextTokens: obs.contextTokens,
      cacheWriteTokens: obs.cacheWriteTokens ?? 0,
    };
  }

  // cache read == 0
  if (obs.contextTokens >= MISS_MIN_CONTEXT || prevContext >= MISS_MIN_CONTEXT) {
    return {
      kind: 'MISS',
      timestamp: obs.timestamp,
      cacheReadTokens: 0,
      contextTokens: obs.contextTokens,
      cacheWriteTokens: obs.cacheWriteTokens ?? 0,
    };
  }
  return null;
}

/** Facts for a time-sorted observation list (last one is the freshest fact). */
export function factsFromObservations(observations: CacheObservation[]): CacheFact[] {
  const sorted = [...observations].sort((a, b) => a.timestamp - b.timestamp);
  const facts: CacheFact[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const fact = classifyFact(sorted[i]!, i > 0 ? sorted[i - 1] : undefined);
    if (fact) facts.push(fact);
  }
  return facts;
}

export interface EstimatorInput {
  /** Deduped observations of the main thread (sidechains excluded). */
  observations: CacheObservation[];
  /** null = endpoint explicitly unknown; see PolicyInput.baseUrl. */
  baseUrl?: string | null | undefined;
  now?: number | undefined;
  atRiskThresholdMs?: number | undefined;
}

export function estimateCacheState(input: EstimatorInput): CacheStateEstimate {
  const now = input.now ?? Date.now();
  const { observations } = input;

  if (observations.length === 0) {
    return {
      state: 'UNKNOWN',
      confidence: 0,
      reason: 'No cache telemetry found for this session yet.',
    };
  }

  const sorted = [...observations].sort((a, b) => a.timestamp - b.timestamp);
  const latest = sorted[sorted.length - 1]!;
  const ttl = resolveTtlPolicy({
    observations: sorted,
    baseUrl: input.baseUrl,
    model: latest.model,
  });

  const facts = factsFromObservations(sorted);
  const lastFact = facts.length ? facts[facts.length - 1] : undefined;

  if (!lastFact) {
    return {
      state: 'UNKNOWN',
      confidence: 0,
      reason:
        'Observations exist but carry no cache signal yet (missing cache fields or tiny context).',
      ttl,
    };
  }

  // Last cache-touching event: a read (hit) or a rebuild (miss with write>0).
  const lastRebuild =
    [...facts].reverse().find((f) => f.kind !== 'HIT' && f.cacheWriteTokens > 0) ??
    [...facts].reverse().find((f) => f.kind === 'HIT');
  const lastCacheActivityAt = Math.max(
    lastFact.timestamp,
    lastRebuild?.timestamp ?? 0,
  );

  const elapsed = now - lastCacheActivityAt;
  const remaining = ttl.ttlMs - elapsed;
  const atRiskThreshold = input.atRiskThresholdMs ?? DEFAULT_AT_RISK_MS;

  let state: CacheState;
  let confidence: number;
  let reason: string;

  const describeFact =
    lastFact.kind === 'HIT'
      ? `Last verified cache hit ${fmtAgo(elapsed)} (${fmtTok(lastFact.cacheReadTokens)} tokens read)`
      : lastFact.kind === 'MISS'
        ? `Last verified cache miss ${fmtAgo(now - lastFact.timestamp)} (read 0 of ${fmtTok(lastFact.contextTokens)} context tokens)`
        : `Last verified partial miss ${fmtAgo(now - lastFact.timestamp)} (read only ${fmtTok(lastFact.cacheReadTokens)} of ~${fmtTok(lastFact.contextTokens)} context tokens)`;

  if (elapsed <= FRESH_FACT_WINDOW_MS && lastFact.kind === 'HIT') {
    state = 'VERIFIED_HIT';
    confidence = 0.98 * ttlBase(ttl);
    reason = `${describeFact} seconds ago — fresh fact from telemetry.`;
  } else if (lastFact.kind === 'MISS' && lastFact.cacheWriteTokens === 0) {
    state = 'VERIFIED_MISS';
    confidence = 0.95;
    reason = `${describeFact}; nothing was re-cached. Next request starts cold.`;
  } else if (remaining <= 0) {
    state = 'LIKELY_EXPIRED';
    confidence = clamp(0.55 + 0.35 * Math.min(1, -remaining / ttl.ttlMs)) * ttlBase(ttl);
    reason = `${describeFact}, ${fmtAgo(elapsed)} ago — beyond the estimated TTL (${ttl.source}: ${Math.round(ttl.ttlMs / 1000)}s). No new request has verified either way.`;
  } else if (remaining <= atRiskThreshold) {
    state = 'AT_RISK';
    confidence = 0.6 * ttlBase(ttl);
    reason = `${describeFact}, ${fmtAgo(elapsed)} ago — estimated expiry in ~${Math.round(remaining / 1000)}s (${ttl.source}).`;
  } else {
    state = 'LIKELY_HOT';
    confidence = clamp(0.95 - 0.35 * (elapsed / ttl.ttlMs)) * ttlBase(ttl);
    reason = `${describeFact}, ${fmtAgo(elapsed)} ago; estimated TTL ${Math.round(ttl.ttlMs / 1000)}s (${ttl.source}). Inference, not a fact.`;
  }

  return {
    state,
    confidence: Math.round(clamp(confidence) * 100) / 100,
    reason,
    lastFact,
    lastCacheActivityAt,
    ttl,
    ttlRemainingMs: Math.max(0, remaining),
  };
}

/** Policy reliability scales how far a countdown-based state may be trusted. */
function ttlBase(ttl: TtlPolicy): number {
  return 0.5 + 0.5 * ttl.reliability;
}

function clamp(v: number, lo = 0, hi = 1): number {
  return Math.min(hi, Math.max(lo, v));
}

function fmtAgo(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

function fmtTok(n: number): string {
  return n.toLocaleString('en-US');
}

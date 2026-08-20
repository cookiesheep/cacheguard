/**
 * Provider TTL policy resolution.
 *
 * The TTL used for countdowns is NEVER a magic constant in business logic.
 * Resolution order:
 *   1. RUNTIME_TELEMETRY — usage shows a 1h cache regime (ephemeral_1h > 0)
 *   2. STATIC_POLICY    — model + endpoint are native Anthropic → documented TTL
 *   3. EMPIRICAL_ESTIMATE — observed hit/miss gaps from this machine's history
 *   4. UNKNOWN          — gateway with no evidence yet; countdown is a guess
 *
 * Anthropic documented values (2026-08, audit: docs/research-audit-2026-08-19.md):
 *   5m default / 1h opt-in; a cache READ refreshes the TTL for free in BOTH
 *   tiers (1h reuse "rolls the hour forward"). Gateways (BigModel/GLM,
 *   OpenRouter, …) implement their own regimes — static policy only applies
 *   when the endpoint is api.anthropic.com.
 */
import type { AgentKind, CacheObservation, TtlPolicy } from '../types/index.js';

export const ANTHROPIC_TTL_5M_MS = 5 * 60 * 1000;
export const ANTHROPIC_TTL_1H_MS = 60 * 60 * 1000;
export const CODEX_TTL_30M_MS = 30 * 60 * 1000;

export interface PolicyInput {
  /** Most recent observations, oldest first, deduped. */
  observations: CacheObservation[];
  /**
   * Base URL the agent is configured with (settings.json), if any.
   *  - undefined: not inspected → assume default Anthropic endpoint
   *  - null: endpoint explicitly UNKNOWN (e.g. a --claude-dir override hid
   *    the real settings) → never claim STATIC_POLICY
   *  - string: parse it; only anthropic hosts get the static policy
   */
  baseUrl?: string | null | undefined;
  /** Model of the latest observation, if any. */
  model?: string | undefined;
  /** Agent family; inferred from observations when omitted. */
  agent?: AgentKind | undefined;
}

/** Observed survival evidence gathered from consecutive request pairs. */
export interface TtlEvidence {
  survivedGapsMs: number[];
  expiredGapsMs: number[];
}

const MIN_CONTEXT_FOR_EVIDENCE = 8192; // below this, hit/miss of the bulk is noise
const HIT_FRACTION = 0.5; // next read ≥ 50% of previous context → bulk survived
const MISS_FRACTION = 0.2; // next read ≤ 20% → bulk expired
const MIN_EVIDENCE_POINTS = 3;
/** Conservative haircut on survived gaps (response gaps overstate idle time). */
const SURVIVED_GAP_HAIRCUT = 0.8;
/**
 * Misses where the context itself shrank are compaction/truncation/resume
 * events (prefix replaced), not TTL expiry — exclude from TTL evidence.
 */
const COMPACTION_CONTEXT_DROP = 0.6;
/**
 * Sub-minute gaps carry no TTL signal: every known TTL floor is minutes-scale,
 * and sub-minute "misses" are prefix breaks (interleaved background requests
 * with different prefixes, tool-result insertions), not expiry.
 */
const MIN_EVIDENCE_GAP_MS = 60_000;

/**
 * Pairwise evidence extraction. Gap = time between consecutive RESPONSE
 * timestamps, which overstates true idle time by request N+1's processing
 * time (cache is read at prefill, before the response lands; Anthropic
 * measures TTL from request START, with generation time counting against
 * it). Survived gaps therefore overstate the survivable idle;
 * resolveTtlPolicy applies a conservative haircut so the countdown errs
 * toward warning early instead of falsely promising "still hot".
 */
export function extractTtlEvidence(observations: CacheObservation[]): TtlEvidence {
  const sorted = [...observations].sort((a, b) => a.timestamp - b.timestamp);
  const evidence: TtlEvidence = { survivedGapsMs: [], expiredGapsMs: [] };
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const next = sorted[i]!;
    if (!prev.contextTokens || prev.contextTokens < MIN_CONTEXT_FOR_EVIDENCE) continue;
    if (next.cacheReadTokens === undefined || next.contextTokens === undefined) continue;
    const gap = next.timestamp - prev.timestamp;
    if (gap < MIN_EVIDENCE_GAP_MS) continue; // sub-minute gaps carry no TTL signal
    // Context bulk disappeared → compaction/resume, not TTL behaviour.
    if (next.contextTokens < prev.contextTokens * COMPACTION_CONTEXT_DROP) continue;
    const survivalRatio = next.cacheReadTokens / prev.contextTokens;
    if (survivalRatio >= HIT_FRACTION) evidence.survivedGapsMs.push(gap);
    else if (survivalRatio <= MISS_FRACTION) evidence.expiredGapsMs.push(gap);
  }
  return evidence;
}

function empiricalPolicy(evidence: TtlEvidence): TtlPolicy | null {
  const { survivedGapsMs, expiredGapsMs } = evidence;
  if (survivedGapsMs.length + expiredGapsMs.length < MIN_EVIDENCE_POINTS) return null;
  const survived = survivedGapsMs.length ? Math.max(...survivedGapsMs) : undefined;
  const expired = expiredGapsMs.length ? Math.min(...expiredGapsMs) : undefined;
  if (survived === undefined) {
    // only misses observed → TTL is below the smallest miss gap; use half of it
    const guess = expired! / 2;
    return {
      ttlMs: guess,
      source: 'EMPIRICAL_ESTIMATE',
      reason: `All ${expiredGapsMs.length} observed idle gaps ≥ ${Math.round(expired! / 1000)}s missed; assuming TTL ≈ half the smallest miss gap.`,
      reliability: 0.55,
      observedExpiredMs: expired,
    };
  }
  const ttlMs = Math.round(survived * SURVIVED_GAP_HAIRCUT);
  if (expired !== undefined && expired <= survived) {
    // contradictory (partial caching etc.) → report the overlap honestly
    return {
      ttlMs,
      source: 'EMPIRICAL_ESTIMATE',
      reason: `Evidence is contradictory: survived ${Math.round(survived / 1000)}s but also missed by ${Math.round(expired / 1000)}s; using the survived bound ×${SURVIVED_GAP_HAIRCUT} (partial caching likely).`,
      reliability: 0.4,
      observedSurvivedMs: survived,
      observedExpiredMs: expired,
    };
  }
  return {
    ttlMs,
    source: 'EMPIRICAL_ESTIMATE',
    reason: `Observed cache survival up to ${Math.round(survived / 1000)}s${expired ? ` and a miss by ${Math.round(expired / 1000)}s` : ''} in this session's history; countdown uses ×${SURVIVED_GAP_HAIRCUT} haircut (response gaps overstate idle time).`,
    reliability: 0.7,
    observedSurvivedMs: survived,
    observedExpiredMs: expired,
  };
}

export function resolveTtlPolicy(input: PolicyInput): TtlPolicy {
  const { observations } = input;

  // Codex branch — OpenAI caching regimes (audit 2026-08-19 §1.3):
  //   GPT-5.6+:   30-minute precise TTL (prompt_cache_options.ttl='30m'),
  //               reuse refreshes without a write fee.
  //   pre-GPT-5.6: in-memory 5-10min OR extended retention up to 24h
  //               (non-ZDR orgs default 24h since 2026-05) — the two are
  //               INDISTINGUISHABLE from local session data. We must never
  //               pretend to know: UNKNOWN unless this machine's history
  //               provides empirical evidence.
  //   Custom providers (session_meta.model_provider != openai) may deviate
  //   from the documented regime; noted in the reason, reliability lowered.
  const agent = input.agent ?? observations[observations.length - 1]?.agent;
  if (agent === 'codex') {
    const model = input.model ?? observations[observations.length - 1]?.model;
    if (model && isGpt56Family(model)) {
      return {
        ttlMs: CODEX_TTL_30M_MS,
        source: 'STATIC_POLICY',
        reason: `${model}: documented GPT-5.6 regime — 30-minute TTL, refreshed on reuse. Custom providers may deviate.`,
        reliability: 0.85,
      };
    }
    const empirical = empiricalPolicy(extractTtlEvidence(observations));
    if (empirical) return empirical;
    return {
      ttlMs: 5 * 60 * 1000,
      source: 'UNKNOWN',
      reason: `${model ?? 'Unknown model'} predates GPT-5.6: TTL is 5-10min in-memory OR up to 24h extended retention — the two cannot be distinguished from local data. Countdown assumes 5m as a conservative placeholder.`,
      reliability: 0.2,
    };
  }

  // Claude Code branch — Anthropic regimes.
  // 1. Runtime regime evidence: 1h ephemeral writes in recent history.
  const recent = observations.slice(-50);
  if (recent.some((o) => (o.oneHourCacheTokens ?? 0) > 0)) {
    return {
      ttlMs: ANTHROPIC_TTL_1H_MS,
      source: 'RUNTIME_TELEMETRY',
      reason: 'Telemetry shows ephemeral_1h_input_tokens > 0 → 1-hour cache regime.',
      reliability: 0.95,
    };
  }

  // 2. Native Anthropic endpoint → documented policy. Claimed ONLY when the
  //    endpoint was actually inspected and matches Anthropic; null (endpoint
  //    unknown, e.g. --claude-dir override) must never masquerade as native.
  const native =
    input.baseUrl === undefined
      ? true
      : (() => {
          if (input.baseUrl === null) return false;
          try {
            const host = new URL(input.baseUrl).hostname;
            return host === 'api.anthropic.com' || host.endsWith('.anthropic.com');
          } catch {
            return false;
          }
        })();
  if (native && input.baseUrl !== null) {
    return {
      ttlMs: ANTHROPIC_TTL_5M_MS,
      source: 'STATIC_POLICY',
      reason: 'Anthropic native endpoint: documented 5-minute TTL, refreshed on each read.',
      reliability: 0.9,
    };
  }

  // 3. Gateway → empirical, if we have evidence.
  const empirical = empiricalPolicy(extractTtlEvidence(observations));
  if (empirical) return empirical;

  // 4. Unknown gateway, no evidence.
  return {
    ttlMs: ANTHROPIC_TTL_5M_MS,
    source: 'UNKNOWN',
    reason: `Non-Anthropic or unverified endpoint (${safeHost(input.baseUrl)}); no survival evidence yet. Countdown assumes 5m as a placeholder — treat as low confidence.`,
    reliability: 0.25,
  };
}

/** GPT-5.6+ model family → 30-minute TTL regime applies. */
function isGpt56Family(model: string): boolean {
  const m = model.toLowerCase();
  return /^gpt-5\.6/.test(m) || /^gpt-5\.[7-9]/.test(m) || /^gpt-[6-9]/.test(m);
}

function safeHost(url?: string | null): string {
  if (!url) return 'unspecified';
  try {
    return new URL(url).hostname;
  } catch {
    return 'unparseable';
  }
}

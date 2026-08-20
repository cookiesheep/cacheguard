/**
 * Cost Engine v1 — turns observed telemetry into an honest economic ledger.
 *
 * Two ledgers, never merged (docs/cost-engine.md):
 *  - VERIFIED bleed: only from classifyFact MISS/PARTIAL_MISS facts — "how
 *    much more did this request cost vs a full cache hit".
 *  - ESTIMATED cold exposure: forward-looking — "if the cache expired now".
 *
 * Honesty invariants:
 *  - PRICING_UNKNOWN → token ledger only, never invented USD
 *  - quota modes (GLM) → token ledger only
 *  - inferred write surcharges are displayed but NEVER summed into verified
 *  - codex bleed is a LOWER BOUND (write surcharge unobservable)
 */
import type { AgentKind, CacheObservation } from '../types/index.js';
import { classifyFact } from '../cache/estimator.js';
import { resolvePricing, type PricingStatus } from './pricing.js';

export type Attribution =
  | 'model-switch'
  | 'suspected-ttl'
  | 'compaction'
  | 'suspected-prefix-break'
  | 'unknown';

export interface BleedEntry {
  timestamp: number;
  requestId: string;
  kind: 'MISS' | 'PARTIAL_MISS';
  attribution: Attribution;
  model?: string | undefined;
  contextTokens: number;
  cacheReadTokens: number;
  /** Verified bleed in USD; undefined when pricing unknown/quota. */
  bleedUsd?: number | undefined;
  inferredWriteSurchargeUsd?: number | undefined;
  lowerBound?: boolean | undefined;
  note?: string | undefined;
}

export interface CostLedger {
  agent: AgentKind;
  pricingStatus: PricingStatus;
  snapshotDate: string;
  totals: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    /** Models seen (pricing may differ per request). */
    models: string[];
  };
  /** Actual prefill-side spend (input+read+write), USD; undefined unless priced.
   *  Uses officialCostUsd per request when present (source official). */
  spendUsd?: {
    prefillUsd: number;
    outputUsd?: number | undefined;
    source: 'official' | 'snapshot' | 'mixed';
  } | undefined;
  /** Cache saving vs a no-cache world (read discount minus write premium). */
  savingsVsNoCacheUsd?: number | undefined;
  verified: {
    entries: BleedEntry[];
    /** Sum of verified bleedUsd — inferred values NEVER included. */
    bleedUsd: number | undefined;
    /** Token-denominated bleed for quota/unknown pricing. */
    lostContextTokens: number;
  };
  estimated: {
    coldExposureUsd?: number | undefined;
    coldExposureTokens: number;
    assumption: string;
  };
}

const ATTR_GAP_TTL_MS = 60_000;
const ATTR_COMPACTION_DROP = 0.6;

export function computeCostLedger(input: {
  agent: AgentKind;
  observations: CacheObservation[];
  now?: number | undefined;
}): CostLedger {
  const { agent, observations } = input;
  const sorted = [...observations].sort((a, b) => a.timestamp - b.timestamp);
  const semantics = agent === 'codex' ? 'openai' : 'anthropic';

  const models = [...new Set(sorted.map((o) => o.model).filter((m): m is string => !!m))];
  const pricingStatus = resolvePricing(models[models.length - 1]);

  const totals = {
    requests: sorted.length,
    inputTokens: sum(sorted, (o) => o.inputTokens),
    outputTokens: sum(sorted, (o) => o.outputTokens),
    cacheReadTokens: sum(sorted, (o) => o.cacheReadTokens),
    cacheWriteTokens: sum(sorted, (o) => o.cacheWriteTokens),
    models,
  };

  // ---- verified bleed entries ----
  const entries: BleedEntry[] = [];
  let bleedUsdAcc = 0;
  let bleedUsdAny = false;
  let lostContextTokens = 0;

  for (let i = 0; i < sorted.length; i++) {
    const obs = sorted[i]!;
    const prev = i > 0 ? sorted[i - 1] : undefined;
    const fact = classifyFact(obs, prev);
    if (!fact || fact.kind === 'HIT') continue;

    const attribution = attribute(obs, prev);
    lostContextTokens += Math.max(0, fact.contextTokens - fact.cacheReadTokens);

    const entry: BleedEntry = {
      timestamp: fact.timestamp,
      requestId: obs.requestId,
      kind: fact.kind,
      attribution,
      model: obs.model,
      contextTokens: fact.contextTokens,
      cacheReadTokens: fact.cacheReadTokens,
    };

    const p = resolvePricing(obs.model);
    if (p.kind === 'priced') {
      const { entry: price } = p;
      const pIn = price.inputPerMTok;
      const pRead = price.cacheReadPerMTok;
      const pWrite = price.cacheWrite5mPerMTok;

      if (semantics === 'anthropic') {
        // context = input + read + write → uncached = input_tokens
        const uncached = obs.inputTokens ?? 0;
        let bleed = (uncached * (pIn - pRead)) / 1e6;
        let inferredSurcharge: number | undefined;
        const writeKnown = !obs.cacheWriteUnknown && (obs.cacheWriteTokens ?? 0) > 0;
        if (writeKnown && pWrite !== null) {
          bleed += ((obs.cacheWriteTokens ?? 0) * (pWrite - pRead)) / 1e6;
        } else if (obs.cacheWriteUnknown && pWrite !== null) {
          // write amount unobservable → inferred, kept OUT of verified sums
          const inferredWrite = uncached;
          inferredSurcharge = (inferredWrite * (pWrite - pRead)) / 1e6;
        }
        entry.bleedUsd = round6(bleed);
        entry.inferredWriteSurchargeUsd =
          inferredSurcharge !== undefined ? round6(inferredSurcharge) : undefined;
      } else {
        // openai: context = input (cached ⊆ input) → uncached = input − cached
        const uncached = Math.max(0, (obs.inputTokens ?? 0) - (obs.cacheReadTokens ?? 0));
        entry.bleedUsd = round6((uncached * (pIn - pRead)) / 1e6);
        entry.lowerBound = true;
        entry.note = 'lower bound — cache-write surcharge unobservable on this agent';
        if (obs.cacheWriteUnknown && pWrite !== null) {
          entry.inferredWriteSurchargeUsd = round6((uncached * (pWrite - pRead)) / 1e6);
        }
      }
      if (entry.bleedUsd !== undefined) {
        bleedUsdAcc += entry.bleedUsd;
        bleedUsdAny = true;
      }
    } else {
      entry.note =
        p.kind === 'quota'
          ? 'quota pricing (cached counts fully) — token ledger only'
          : 'no verified list price — token ledger only';
    }
    entries.push(entry);
  }

  // ---- spend & savings (priced observations only) ----
  let spend: CostLedger['spendUsd'];
  let savings: number | undefined;
  {
    let prefill = 0;
    let output = 0;
    let official = 0;
    let snapshotCosted = 0;
    let anyPriced = false;
    let savingsAcc = 0;
    for (const o of sorted) {
      const p = resolvePricing(o.model);
      if (p.kind !== 'priced') continue;
      anyPriced = true;
      const { entry: price } = p;
      if (typeof o.officialCostUsd === 'number') {
        // claude-code records can carry the provider-computed cost — prefer it
        official += o.officialCostUsd;
        continue;
      }
      snapshotCosted++;
      const uncached = semantics === 'anthropic'
        ? (o.inputTokens ?? 0)
        : Math.max(0, (o.inputTokens ?? 0) - (o.cacheReadTokens ?? 0));
      const write = o.cacheWriteUnknown ? 0 : (o.cacheWriteTokens ?? 0);
      prefill +=
        (uncached * price.inputPerMTok +
          (o.cacheReadTokens ?? 0) * price.cacheReadPerMTok +
          write * (price.cacheWrite5mPerMTok ?? price.cacheReadPerMTok)) / 1e6;
      if (price.outputPerMTok !== null) {
        output += ((o.outputTokens ?? 0) * price.outputPerMTok) / 1e6;
      }
      savingsAcc +=
        ((o.cacheReadTokens ?? 0) * (price.inputPerMTok - price.cacheReadPerMTok) +
          write * (price.cacheReadPerMTok - (price.cacheWrite5mPerMTok ?? price.cacheReadPerMTok))) /
        1e6;
    }
    if (anyPriced) {
      spend = {
        prefillUsd: round6(prefill + official),
        outputUsd: output > 0 ? round6(output) : undefined,
        source: official > 0 && snapshotCosted > 0 ? 'mixed' : official > 0 ? 'official' : 'snapshot',
      };
      savings = round6(savingsAcc);
    }
  }

  // ---- estimated cold exposure ----
  const latest = sorted[sorted.length - 1];
  const p = latest ? resolvePricing(latest.model) : pricingStatus;
  let coldExposureUsd: number | undefined;
  if (latest && p.kind === 'priced') {
    coldExposureUsd =
      round6(((latest.contextTokens ?? 0) * (p.entry.inputPerMTok - p.entry.cacheReadPerMTok)) / 1e6);
  }

  return {
    agent,
    pricingStatus,
    snapshotDate: pricingStatus.snapshotDate,
    totals,
    spendUsd: spend,
    savingsVsNoCacheUsd: savings,
    verified: {
      entries,
      bleedUsd: bleedUsdAny ? round6(bleedUsdAcc) : undefined,
      lostContextTokens,
    },
    estimated: {
      coldExposureUsd,
      coldExposureTokens: latest?.contextTokens ?? 0,
      assumption:
        'if the cache expired right now, the next request would re-prefill the current context at input price instead of read price',
    },
  };
}

function attribute(obs: CacheObservation, prev?: CacheObservation): Attribution {
  if (!prev || !prev.contextTokens || !obs.contextTokens) return 'unknown';
  // Concrete signals outrank generic guesses: a model switch across the miss
  // boundary provably drops the cache (official docs) — attribute it first.
  if (prev.model && obs.model && prev.model !== obs.model) return 'model-switch';
  const gap = obs.timestamp - prev.timestamp;
  if (obs.contextTokens < prev.contextTokens * ATTR_COMPACTION_DROP) return 'compaction';
  if (gap >= ATTR_GAP_TTL_MS) return 'suspected-ttl';
  return 'suspected-prefix-break';
}

function sum(obs: CacheObservation[], pick: (o: CacheObservation) => number | undefined): number {
  return obs.reduce((s, o) => s + (pick(o) ?? 0), 0);
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

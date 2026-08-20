/**
 * Pricing resolution — vendored snapshot, zero network.
 *
 * Honesty rules (docs/cost-engine.md):
 *  - unknown model → PRICING_UNKNOWN (token ledger only, never invented USD)
 *  - bare aliases (sonnet/opus/haiku) → unknown: generation is a guess
 *  - GLM gateway models → quota mode (cached counts fully, no USD list price)
 */
import snapshotJson from './pricing-snapshot.json' with { type: 'json' };
import type { AgentKind } from '../types/index.js';

interface ModelEntry {
  match: string[];
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  cacheReadPerMTok: number;
  cacheWrite5mPerMTok: number | null;
  cacheWrite1hPerMTok: number | null;
  writeTtl?: string;
  sourceUrl: string;
}
interface QuotaEntry {
  match: string[];
  mode: string;
  note: string;
  sourceUrl: string;
}
interface Snapshot {
  snapshotDate: string;
  currency: string;
  models: ModelEntry[];
  quotaModes: QuotaEntry[];
}

const snapshot = snapshotJson as unknown as Snapshot;

export type PricingStatus =
  | { kind: 'priced'; entry: PricedModelEntry; snapshotDate: string }
  | { kind: 'quota'; entry: QuotaEntry; snapshotDate: string }
  | { kind: 'PRICING_UNKNOWN'; snapshotDate: string };

/** A model entry usable for USD math (null-input entries are filtered out). */
export type PricedModelEntry = ModelEntry & { inputPerMTok: number };

/** Resolve pricing for a model string. Prefix match, longest pattern wins. */
export function resolvePricing(model: string | undefined): PricingStatus {
  if (!model) return unknown();
  const m = model.toLowerCase();

  // Quota modes first (gateway models are unambiguous prefixes like "glm-").
  const quota = snapshot.quotaModes
    .filter((q) => q.match.some((p) => m.startsWith(p.toLowerCase())))
    .sort((a, b) => bestLen(b) - bestLen(a))[0];
  if (quota) return { kind: 'quota', entry: quota, snapshotDate: snapshot.snapshotDate };

  const hit = snapshot.models
    .filter((e) => e.inputPerMTok !== null)
    .filter((e) => e.match.some((p) => m.startsWith(p.toLowerCase())))
    .sort((a, b) => bestLen(b) - bestLen(a))[0];
  if (hit) return { kind: 'priced', entry: hit as PricedModelEntry, snapshotDate: snapshot.snapshotDate };

  return unknown();

  function bestLen(e: { match: string[] }): number {
    return Math.max(...e.match.map((p) => (m.startsWith(p.toLowerCase()) ? p.length : -1)));
  }
}

function unknown(): PricingStatus {
  return { kind: 'PRICING_UNKNOWN', snapshotDate: snapshot.snapshotDate };
}

export function snapshotDate(): string {
  return snapshot.snapshotDate;
}

/** Context accounting semantics per agent (docs/codex-schema.md §4.1). */
export function contextSemantics(agent: AgentKind): 'anthropic' | 'openai' {
  return agent === 'codex' ? 'openai' : 'anthropic';
}

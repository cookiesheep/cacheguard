/**
 * Cache Doctor — attribution deepening + actionable advice.
 *
 * Works ONLY on metadata (timestamps, token counters, model names). Never
 * reads, stores, or fingerprints conversation content — that is a documented
 * privacy red line (docs/doctor.md). Token-level prefix diffing would need
 * content fingerprints → future opt-in feature, explicitly out of scope.
 *
 * Every conclusion carries a suspected/inferred label; advice text never
 * makes certainty claims and always names its evidence.
 */
import type { AgentKind, CacheObservation } from '../types/index.js';
import { computeCostLedger, type BleedEntry, type CostLedger } from '../cost/engine.js';

export interface RecurringLayer {
  /** Approximate residual read size shared by the cluster (tok). */
  approxTokens: number;
  occurrences: number;
  timestamps: number[];
  note: string;
}

export interface HourCluster {
  /** Local-time "YYYY-MM-DD HH:00". */
  hour: string;
  events: number;
  lostTokens: number;
}

export interface Advice {
  signal: string;
  evidence: string;
  text: string;
}

export interface DoctorReport {
  sessionId: string;
  agent: AgentKind;
  ledger: CostLedger;
  attributionCounts: Record<string, number>;
  recurringLayers: RecurringLayer[];
  hourClusters: HourCluster[];
  modelSwitches: Array<{ at: number; from: string; to: string }>;
  advice: Advice[];
  privacyNote: string;
}

const LAYER_TOLERANCE = 0.15; // residuals within ±15% cluster together
const MIN_LAYER_OCCURRENCES = 2;

export function analyzeDoctor(input: {
  sessionId: string;
  agent: AgentKind;
  observations: CacheObservation[];
}): DoctorReport {
  const { sessionId, agent, observations } = input;
  const sorted = [...observations].sort((a, b) => a.timestamp - b.timestamp);
  const ledger = computeCostLedger({ agent, observations: sorted });
  const entries = ledger.verified.entries;

  // ---- attribution counts + model switch details ----
  const attributionCounts: Record<string, number> = {};
  const modelSwitches: Array<{ at: number; from: string; to: string }> = [];
  for (const e of entries) {
    attributionCounts[e.attribution] = (attributionCounts[e.attribution] ?? 0) + 1;
    if (e.attribution === 'model-switch') {
      const idx = sorted.findIndex((o) => o.requestId === e.requestId);
      const prev = idx > 0 ? sorted[idx - 1] : undefined;
      if (prev?.model && e.model && prev.model !== e.model) {
        modelSwitches.push({ at: e.timestamp, from: prev.model, to: e.model });
      }
    }
  }

  // ---- recurring residual layers (partial misses with similar leftovers) ----
  const partials = entries.filter((e) => e.kind === 'PARTIAL_MISS');
  const layers: RecurringLayer[] = [];
  const clustered = new Set<number>();
  for (let i = 0; i < partials.length; i++) {
    if (clustered.has(i)) continue;
    const seed = partials[i]!;
    const group = [seed];
    for (let j = i + 1; j < partials.length; j++) {
      if (clustered.has(j)) continue;
      const other = partials[j]!;
      if (Math.abs(other.cacheReadTokens - seed.cacheReadTokens) <= seed.cacheReadTokens * LAYER_TOLERANCE) {
        group.push(other);
        clustered.add(j);
      }
    }
    if (group.length >= MIN_LAYER_OCCURRENCES) {
      layers.push({
        approxTokens: Math.round(group.reduce((s, g) => s + g.cacheReadTokens, 0) / group.length),
        occurrences: group.length,
        timestamps: group.map((g) => g.timestamp),
        note:
          `suspected layered cache residue: ${group.length} partial misses left a similar ` +
          `~${Math.round(group.reduce((s, g) => s + g.cacheReadTokens, 0) / group.length).toLocaleString()} tok ` +
          `sub-prefix readable while the bulk was lost (inferred — consistent with a longer-lived base checkpoint)`,
      });
    }
  }

  // ---- hour clustering ----
  const hourMap = new Map<string, HourCluster>();
  for (const e of entries) {
    const d = new Date(e.timestamp);
    const hour = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:00`;
    const c = hourMap.get(hour) ?? { hour, events: 0, lostTokens: 0 };
    c.events++;
    c.lostTokens += Math.max(0, e.contextTokens - e.cacheReadTokens);
    hourMap.set(hour, c);
  }
  const hourClusters = [...hourMap.values()].sort((a, b) => b.events - a.events || b.lostTokens - a.lostTokens);

  // ---- evidence-tied advice ----
  const advice: Advice[] = [];
  const push = (signal: string, evidence: string, text: string) => advice.push({ signal, evidence, text });

  const ttlCount = attributionCounts['suspected-ttl'] ?? 0;
  if (ttlCount >= 1) {
    push(
      'suspected-ttl',
      `${ttlCount} miss(es) after idle gaps ≥60s with stable context`,
      `Misses appear to follow idle time: consider returning to the session within the estimated TTL window (see status output for the current countdown) — inferred, not verified causation.`,
    );
  }
  const breakCount = attributionCounts['suspected-prefix-break'] ?? 0;
  if (breakCount >= 2) {
    push(
      'suspected-prefix-break',
      `${breakCount} miss(es) at short gaps (<60s) with stable context — the prefix likely changed between turns`,
      `Short-gap misses suggest the prompt prefix itself changed: check whether plugins, tool definitions, or MCP servers modify the system prompt between turns (a real-world example: memory plugins rewrite their injected block between calls). Inferred from timing only.`,
    );
  }
  const compactionCount = attributionCounts['compaction'] ?? 0;
  if (compactionCount >= 1) {
    push(
      'compaction',
      `${compactionCount} miss(es) with context collapsing to <60% of the previous size`,
      `Context shrank sharply at these points — /compact (manual or auto) rewrites the prefix by design; the miss itself is expected, the cost line is informational.`,
    );
  }
  if (modelSwitches.length > 0) {
    push(
      'model-switch',
      modelSwitches.map((m) => `${m.from} → ${m.to}`).join(', '),
      `A model switch across these points provably drops the cache (official behavior); keeping one model per session preserves the prefix.`,
    );
  }
  if (layers.length > 0) {
    push(
      'recurring-residual-layer',
      layers.map((l) => `~${l.approxTokens.toLocaleString()} tok ×${l.occurrences}`).join('; '),
      `Repeated similar residual reads suggest a layered cache where a base sub-prefix outlives the bulk (inferred); TTL countdowns on this provider should be treated as distributions, not constants.`,
    );
  }

  return {
    sessionId,
    agent,
    ledger,
    attributionCounts,
    recurringLayers: layers,
    hourClusters,
    modelSwitches,
    advice,
    privacyNote:
      'metadata-only analysis: token counters, timestamps, model names. No conversation content is read, stored, or fingerprinted.',
  };
}

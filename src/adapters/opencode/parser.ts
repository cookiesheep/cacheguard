/**
 * OpenCode message parser (SQLite rows, not JSONL).
 *
 * Token semantics — VERIFIED against real data (23/23 non-degenerate
 * messages, docs/opencode-schema.md §3):
 *   tokens.total = input + output + reasoning + cache.read
 * → `input` EXCLUDES cached tokens (Anthropic ADDITIVE convention even for
 *   OpenAI providers — OpenCode normalizes provider usage into this shape).
 *   contextTokens = input + cache.read + cache.write.
 *
 * Privacy: message `data` contains conversation summaries/metadata; this
 * parser reads ONLY tokens / cost / model / provider / time fields. The
 * `part` table (conversation bodies) is never queried.
 */
import type { CacheObservation, ParserStats } from '../../types/index.js';
import type { OpenCodeMessageRow } from './paths.js';

interface DataShape {
  role?: unknown;
  modelID?: unknown;
  providerID?: unknown;
  cost?: unknown;
  tokens?: {
    total?: unknown;
    input?: unknown;
    output?: unknown;
    reasoning?: unknown;
    cache?: { read?: unknown; write?: unknown } | null;
  } | null;
  time?: { created?: unknown; completed?: unknown } | null;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export class OpenCodeParser {
  private readonly seen = new Set<string>();
  readonly stats: ParserStats = {
    linesRead: 0,
    parseErrors: 0,
    unknownRecordTypes: 0,
    nonAssistantRecords: 0,
    syntheticRecords: 0,
    sidechainRecords: 0,
    partialUsageRecords: 0,
    duplicateRecords: 0,
    observations: 0,
  };

  parseRow(row: OpenCodeMessageRow): CacheObservation | null {
    this.stats.linesRead++;
    let data: DataShape;
    try {
      data = JSON.parse(row.data) as DataShape;
    } catch {
      this.stats.parseErrors++;
      return null;
    }
    if (data.role !== 'assistant' || !data.tokens) {
      this.stats.nonAssistantRecords++;
      return null;
    }
    if (this.seen.has(row.id)) {
      this.stats.duplicateRecords++;
      return null;
    }
    this.seen.add(row.id);

    const t = data.tokens;
    const inputTokens = num(t.input);
    const cacheRead = num(t.cache?.read);
    const cacheWrite = num(t.cache?.write);
    const outputTokens = num(t.output);

    const timestamp = num(data.time?.created) ?? row.time_created;
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      this.stats.parseErrors++;
      return null;
    }

    const partial =
      inputTokens === undefined || cacheRead === undefined || outputTokens === undefined;
    if (partial) this.stats.partialUsageRecords++;

    // F2 guard: degenerate all-zero rows (real-data confirmed to exist) prove
    // nothing and must not become observations.
    const contextTokens =
      inputTokens !== undefined
        ? inputTokens + (cacheRead ?? 0) + (cacheWrite ?? 0)
        : undefined;
    if (contextTokens === 0) {
      this.stats.syntheticRecords++;
      this.seen.delete(row.id);
      return null;
    }

    this.stats.observations++;
    return {
      timestamp,
      agent: 'opencode',
      sessionId: 'opencode', // engine rewrites to the discovered session id
      requestId: row.id,
      model: str(data.modelID),
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      // OpenCode never reports write-unknown state: cache.write is always a
      // real (possibly 0) number in the normalized shape.
      cacheWriteUnknown: false,
      contextTokens,
      partial,
      source: 'opencode.db',
      agentVersion: undefined,
      officialCostUsd: (num(data.cost) ?? 0) > 0 ? num(data.cost) : undefined,
    };
  }

  parseRows(rows: OpenCodeMessageRow[]): CacheObservation[] {
    const out: CacheObservation[] = [];
    for (const r of rows) {
      const obs = this.parseRow(r);
      if (obs) out.push(obs);
    }
    return out;
  }
}

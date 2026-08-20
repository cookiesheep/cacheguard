/**
 * Claude Code session JSONL parser.
 *
 * Robustness rules (see docs/claude-code-schema.md §9):
 *  - unknown record types / unknown fields → skip, count, never throw
 *  - `<synthetic>` / isApiErrorMessage records → skip (zeroed usage)
 *  - sidechain (subagent) records → skip by default
 *  - missing usage fields → partial observation, not a dropped record
 *  - one API response = many file records → dedupe by message.id
 *
 * This module never touches message.content — token counters and metadata only.
 */
import type { CacheObservation, ParserStats } from '../../types/index.js';

/** Minimal shapes we rely on; everything else is intentionally `unknown`. */
interface UsageShape {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation?: {
    ephemeral_5m_input_tokens?: unknown;
    ephemeral_1h_input_tokens?: unknown;
  };
}

interface RecordShape {
  type?: unknown;
  timestamp?: unknown;
  sessionId?: unknown;
  version?: unknown;
  isSidechain?: unknown;
  costUSD?: unknown;
  message?: {
    id?: unknown;
    model?: unknown;
    usage?: UsageShape;
  };
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export class ObservationParser {
  private readonly seenRequestIds = new Set<string>();
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

  constructor(private readonly options: { includeSidechain?: boolean } = {}) {}

  /**
   * Parse one JSONL line into an observation, or null when the line is not
   * a usable assistant-usage record. Never throws.
   */
  parseLine(line: string, source: string): CacheObservation | null {
    this.stats.linesRead++;
    const trimmed = line.trim();
    if (!trimmed) return null;

    let record: RecordShape;
    try {
      record = JSON.parse(trimmed) as RecordShape;
    } catch {
      // Truncated mid-write line (tailer buffers these) or genuine corruption.
      this.stats.parseErrors++;
      return null;
    }

    if (typeof record.type !== 'string') {
      this.stats.unknownRecordTypes++;
      return null;
    }
    if (record.type !== 'assistant') {
      // Known-irrelevant or unknown-but-benign types are indistinguishable
      // for our purposes: both are counted as non-observations.
      this.stats.nonAssistantRecords++;
      return null;
    }

    if (record.isSidechain === true && !this.options.includeSidechain) {
      this.stats.sidechainRecords++;
      return null;
    }

    const message = record.message;
    if (!message || typeof message !== 'object' || !message.usage) {
      // assistant chunk without usage (streaming artifacts) — nothing to observe
      this.stats.nonAssistantRecords++;
      return null;
    }

    const model = str(message.model);
    if (model === '<synthetic>') {
      // Local placeholder ("No response requested.", API error text): usage is zeroed.
      this.stats.syntheticRecords++;
      return null;
    }

    const usage: UsageShape = message.usage;
    const requestId = str(message.id);
    if (requestId) {
      if (this.seenRequestIds.has(requestId)) {
        // Same API response written once per content block; first copy wins.
        this.stats.duplicateRecords++;
        return null;
      }
      this.seenRequestIds.add(requestId);
    }

    const timestamp = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN;
    if (!Number.isFinite(timestamp)) {
      this.stats.parseErrors++;
      return null;
    }

    const inputTokens = num(usage.input_tokens);
    const outputTokens = num(usage.output_tokens);
    const cacheRead = num(usage.cache_read_input_tokens);
    const cacheWrite = num(usage.cache_creation_input_tokens);
    const fiveMin = num(usage.cache_creation?.ephemeral_5m_input_tokens);
    const oneHour = num(usage.cache_creation?.ephemeral_1h_input_tokens);

    const partial =
      cacheRead === undefined ||
      cacheWrite === undefined ||
      inputTokens === undefined ||
      outputTokens === undefined;
    if (partial) this.stats.partialUsageRecords++;

    // Anthropic accounting: billed prompt = uncached input + cache read + cache write.
    const contextTokens =
      inputTokens !== undefined
        ? (inputTokens ?? 0) +
          (cacheRead ?? 0) +
          (cacheWrite ?? 0)
        : undefined;

    this.stats.observations++;
    return {
      timestamp,
      agent: 'claude-code',
      sessionId: str(record.sessionId) ?? 'unknown-session',
      requestId: requestId ?? `no-id:${timestamp}:${this.stats.observations}`,
      officialCostUsd: num(record.costUSD),
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      contextTokens,
      fiveMinuteCacheTokens: fiveMin,
      oneHourCacheTokens: oneHour,
      partial,
      source,
      agentVersion: str(record.version),
    };
  }

  /** Parse a whole buffer of lines (used for tail snapshots and fixtures). */
  parseBuffer(text: string, source: string): CacheObservation[] {
    const out: CacheObservation[] = [];
    for (const line of text.split('\n')) {
      const obs = this.parseLine(line, source);
      if (obs) out.push(obs);
    }
    return out;
  }
}

/**
 * Codex CLI rollout JSONL parser.
 *
 * Same robustness contract as the Claude Code parser (docs/codex-schema.md):
 *  - unknown record/payload types → skip, count, never throw
 *  - truncated half-line at EOF → parse to nothing (tailer buffers it)
 *  - zstd files are filtered at discovery, not here
 *  - `info: null` token_counts → skip, count (real-data confirmed)
 *  - never reads conversation content: token counters and metadata only
 *
 * Accounting conventions (VERIFIED against real data 2026-08-20, see schema
 * doc §4): input_tokens ALREADY INCLUDES cached_input_tokens (total =
 * input + output holds exactly), so contextTokens = input_tokens — unlike
 * Claude Code where context = in + read + write.
 *
 * cache_write_input_tokens: pre-5.6 models serde-default it to 0 (cannot
 * distinguish "no write" from "unsupported"); the observation carries
 * cacheWriteUnknown instead of pretending 0 is a fact. Real data shows even
 * 5.6 models may report 0 while cache clearly grew — documented as a known
 * limitation, the flag is about FIELD presence/semantics, not honesty of 0.
 */
import type { CacheObservation, ParserStats } from '../../types/index.js';

interface UsageShape {
  input_tokens?: unknown;
  cached_input_tokens?: unknown;
  cache_write_input_tokens?: unknown;
  output_tokens?: unknown;
  reasoning_output_tokens?: unknown;
  total_tokens?: unknown;
}

interface RecordShape {
  timestamp?: unknown;
  type?: unknown;
  payload?: {
    type?: unknown;
    /** token_count payload */
    info?: {
      last_token_usage?: UsageShape;
      total_token_usage?: UsageShape;
      model_context_window?: unknown;
    } | null;
    /** session_meta payload */
    id?: unknown;
    session_id?: unknown;
    cli_version?: unknown;
    model_provider?: unknown;
    /** turn_context payload */
    model?: unknown;
  };
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** GPT-5.6+ models: official 30-minute TTL regime (cache_write reporting era). */
export function isGpt56OrLater(model?: string | undefined): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  if (!/^gpt-5\.6/.test(m) && !/^gpt-5\.[7-9]/.test(m) && !/^gpt-[6-9]/.test(m)) return false;
  return true;
}

/** Ambient per-file state recovered from session_meta / turn_context lines. */
export interface CodexAmbient {
  conversationId?: string | undefined;
  cliVersion?: string | undefined;
  modelProvider?: string | undefined;
  model?: string | undefined;
}

export class CodexParser {
  private readonly seen = new Set<string>();
  private ambient: CodexAmbient;
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

  constructor(ambient: CodexAmbient = {}) {
    this.ambient = { ...ambient };
  }

  /** Ambient state after parsing — feed it into the next parser instance
   *  when the file is read in head+tail chunks. */
  getAmbient(): CodexAmbient {
    return { ...this.ambient };
  }

  /** Extract ambient state from a file head without producing observations. */
  static ambientFromHead(text: string): CodexAmbient {
    const p = new CodexParser();
    for (const line of text.split('\n')) p.parseLine(line, 'head');
    return p.getAmbient();
  }

  parseLine(line: string, source: string): CacheObservation | null {
    this.stats.linesRead++;
    const trimmed = line.trim();
    if (!trimmed) return null;

    let record: RecordShape;
    try {
      record = JSON.parse(trimmed) as RecordShape;
    } catch {
      this.stats.parseErrors++;
      return null;
    }

    if (typeof record.type !== 'string') {
      this.stats.unknownRecordTypes++;
      return null;
    }

    // Ambient metadata carriers — no observation, but state updates.
    if (record.type === 'session_meta' && record.payload) {
      this.ambient.conversationId ??=
        str(record.payload.id) ?? str(record.payload.session_id);
      this.ambient.cliVersion ??= str(record.payload.cli_version);
      this.ambient.modelProvider ??= str(record.payload.model_provider);
      this.stats.nonAssistantRecords++;
      return null;
    }
    if (record.type === 'turn_context' && record.payload) {
      const model = str(record.payload.model);
      if (model) this.ambient.model = model;
      this.stats.nonAssistantRecords++;
      return null;
    }
    if (record.type !== 'event_msg' || !record.payload) {
      this.stats.nonAssistantRecords++; // response_item/world_state/compacted/…
      return null;
    }
    if (record.payload.type !== 'token_count') {
      this.stats.nonAssistantRecords++; // user_message/agent_message/…
      return null;
    }

    // token_count with info:null → real-data confirmed; nothing to observe.
    if (record.payload.info == null) {
      this.stats.syntheticRecords++; // closest bucket: "non-usage token_count"
      return null;
    }
    const usage = record.payload.info.last_token_usage;
    if (!usage) {
      this.stats.nonAssistantRecords++;
      return null;
    }

    const timestamp =
      typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN;
    if (!Number.isFinite(timestamp)) {
      this.stats.parseErrors++;
      return null;
    }

    const inputTokens = num(usage.input_tokens);
    const cacheRead = num(usage.cached_input_tokens);
    const cacheWriteRaw = usage.cache_write_input_tokens;
    const cacheWrite = num(cacheWriteRaw);
    const outputTokens = num(usage.output_tokens);

    const model = this.ambient.model;
    const cacheWriteUnknown =
      cacheWriteRaw === undefined || cacheWrite === undefined
        ? true // field absent — cannot claim "no write"
        : !isGpt56OrLater(model); // pre-5.6: serde default 0, semantics unavailable

    const partial =
      inputTokens === undefined || cacheRead === undefined || outputTokens === undefined;
    if (partial) this.stats.partialUsageRecords++;

    // Stable requestId across re-parses: ms timestamp + input size. Same-ms
    // events with identical usage are true duplicates; different usage is a
    // different request. (ordinal is absent in real 0.147 data.)
    const requestId = `tc:${record.timestamp}:${inputTokens ?? '?'}`;
    if (this.seen.has(requestId)) {
      this.stats.duplicateRecords++;
      return null;
    }
    this.seen.add(requestId);

    this.stats.observations++;
    return {
      timestamp,
      agent: 'codex',
      sessionId: this.ambient.conversationId ?? 'unknown-codex-session',
      requestId,
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite ?? 0,
      cacheWriteUnknown,
      // VERIFIED: input_tokens already includes cached tokens.
      contextTokens: inputTokens,
      partial,
      source,
      agentVersion: this.ambient.cliVersion,
    };
  }

  parseBuffer(text: string, source: string): CacheObservation[] {
    const out: CacheObservation[] = [];
    for (const line of text.split('\n')) {
      const obs = this.parseLine(line, source);
      if (obs) out.push(obs);
    }
    return out;
  }
}

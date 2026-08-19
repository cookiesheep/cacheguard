/**
 * CacheGuard core data model.
 *
 * Everything here is provider-neutral: adapters translate agent-specific
 * local telemetry into these types. Facts (observations) and inferences
 * (estimates) are strictly separated types — never merge them.
 */

export type AgentKind = 'claude-code';

/** One LLM API response, as recovered from local telemetry. This is a FACT. */
export interface CacheObservation {
  /** Epoch ms of the response (from the source record). */
  timestamp: number;
  agent: AgentKind;
  sessionId: string;
  /** Provider response id — the dedupe key (one response → many file records). */
  requestId: string;
  model?: string | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  /** input + cacheRead + cacheWrite (Anthropic usage semantics). */
  contextTokens?: number | undefined;
  fiveMinuteCacheTokens?: number | undefined;
  oneHourCacheTokens?: number | undefined;
  /** True when usage existed but cache fields were missing (version variance). */
  partial: boolean;
  /** File the observation was recovered from. */
  source: string;
  /** Claude Code version string carried by the record, if any. */
  agentVersion?: string | undefined;
}

/** What the latest real request proved about the cache. A FACT. */
export type CacheFactKind = 'HIT' | 'MISS' | 'PARTIAL_MISS';

export interface CacheFact {
  kind: CacheFactKind;
  /** Epoch ms of the request that proved this. */
  timestamp: number;
  cacheReadTokens: number;
  contextTokens: number;
  cacheWriteTokens: number;
}

/** Display states. VERIFIED_* are facts; the rest are inferences. */
export type CacheState =
  | 'VERIFIED_HIT'
  | 'LIKELY_HOT'
  | 'AT_RISK'
  | 'LIKELY_EXPIRED'
  | 'VERIFIED_MISS'
  | 'UNKNOWN';

export type TtlSource = 'STATIC_POLICY' | 'RUNTIME_TELEMETRY' | 'EMPIRICAL_ESTIMATE' | 'UNKNOWN';

export interface TtlPolicy {
  /** Best-estimate TTL in ms used for the countdown. */
  ttlMs: number;
  source: TtlSource;
  /** Human-readable explanation of where ttlMs came from. */
  reason: string;
  /** 0..1 — how much the countdown should be trusted. */
  reliability: number;
  /** Empirical bounds in ms, when observed (survived ≥ lower, expired ≤ upper). */
  observedSurvivedMs?: number | undefined;
  observedExpiredMs?: number | undefined;
}

export interface CacheStateEstimate {
  state: CacheState;
  /** 0..1. Facts are ~1.0; inferences decay with time and policy reliability. */
  confidence: number;
  /** Human-readable, explains the inputs. Every inference must be explainable. */
  reason: string;
  lastFact?: CacheFact | undefined;
  /** Epoch ms of the last cache-touching event (hit or rebuild). */
  lastCacheActivityAt?: number | undefined;
  ttl?: TtlPolicy | undefined;
  ttlRemainingMs?: number | undefined;
}

/** A session file discovered on disk, before any parsing. */
export interface DiscoveredSession {
  agent: AgentKind;
  sessionId: string;
  /** Absolute path to the session JSONL. */
  filePath: string;
  /** Munged project directory name under ~/.claude/projects. */
  projectDir: string;
  sizeBytes: number;
  /** File mtime, epoch ms. */
  modifiedAt: number;
  /** From the live registry (~/.claude/sessions/<pid>.json), when present. */
  registry?: SessionRegistryEntry | undefined;
}

export interface SessionRegistryEntry {
  pid: number;
  sessionId: string;
  cwd?: string | undefined;
  startedAt?: number | undefined;
  status?: string;
  updatedAt?: number;
  version?: string;
  name?: string;
  entrypoint?: string;
}

/** Persisted session row (storage layer owns durability). */
export interface StoredSession {
  sessionId: string;
  agent: AgentKind;
  projectDir?: string | undefined;
  cwd?: string | undefined;
  model?: string | undefined;
  agentVersion?: string | undefined;
  startedAt?: number | undefined;
  lastSeen?: number | undefined;
}

export type CacheEventType =
  | 'SESSION_STARTED'
  | 'VERIFIED_HIT'
  | 'VERIFIED_MISS'
  | 'PARTIAL_MISS'
  | 'TTL_RISK';

export interface CacheEvent {
  sessionId: string;
  /** Epoch ms of the underlying observation/state change. */
  timestamp: number;
  eventType: CacheEventType;
  /** JSON blob with explanation inputs (never message content). */
  detail: string;
}

export interface AgentAdapter {
  readonly kind: AgentKind;
  /** Find session files on disk, most-recently-active first. */
  discoverSessions(): Promise<DiscoveredSession[]>;
}

export interface ParserStats {
  linesRead: number;
  parseErrors: number;
  unknownRecordTypes: number;
  nonAssistantRecords: number;
  syntheticRecords: number;
  sidechainRecords: number;
  partialUsageRecords: number;
  duplicateRecords: number;
  observations: number;
}

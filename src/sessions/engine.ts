/**
 * SessionEngine — orchestrates discovery → parse → persist → estimate.
 *
 * One-shot snapshot (status): read a tail snapshot of the active session
 * (bounded bytes — a 100 MB session must not cost seconds), merge with
 * stored observations, then estimate.
 *
 * Live tracking (watch): same snapshot first, then a JsonlTailer from EOF
 * feeds appends into the same pipeline.
 */
import type {
  CacheEvent,
  CacheEventType,
  CacheObservation,
  CacheStateEstimate,
  DiscoveredSession,
} from '../types/index.js';
import { ClaudeCodeAdapter } from '../adapters/claude-code/adapter.js';
import { ObservationParser } from '../adapters/claude-code/parser.js';
import { readBaseUrlHint } from '../adapters/claude-code/paths.js';
import { readTailSnapshot, JsonlTailer } from '../collector/tailer.js';
import { estimateCacheState, classifyFact } from '../cache/estimator.js';
import { CacheGuardStore } from '../storage/db.js';

const DEFAULT_SNAPSHOT_BYTES = 4 * 1024 * 1024;

export interface SessionStatus {
  session: DiscoveredSession;
  snapshotObservations: CacheObservation[];
  allObservations: CacheObservation[];
  estimate: CacheStateEstimate;
}

export class SessionEngine {
  readonly adapter: ClaudeCodeAdapter;
  readonly store: CacheGuardStore;
  readonly baseUrlHint: string | undefined;
  /** In-memory last state per session — used for edge-triggered TTL_RISK events. */
  private lastStateBySession = new Map<string, string>();

  constructor(
    opts: {
      claudeDirOverride?: string | undefined;
      store?: CacheGuardStore | undefined;
    } = {},
  ) {
    this.adapter = new ClaudeCodeAdapter(opts.claudeDirOverride);
    this.store = opts.store ?? new CacheGuardStore();
    this.baseUrlHint = readBaseUrlHint(opts.claudeDirOverride);
  }

  /** Discover sessions, most recently active first. */
  async discover(): Promise<DiscoveredSession[]> {
    return this.adapter.discoverSessions();
  }

  /**
   * One-shot: tail-snapshot the session, persist observations + events,
   * return the full estimate. `snapshotBytes` bounds the initial read.
   */
  async snapshot(
    session: DiscoveredSession,
    snapshotBytes = DEFAULT_SNAPSHOT_BYTES,
  ): Promise<SessionStatus> {
    const snapshotObs = this.readSnapshot(session, snapshotBytes);
    const stored = this.store.observationsFor(session.sessionId);
    const all = mergeObservations(stored, snapshotObs);
    this.persist(session, snapshotObs, all);

    const estimate = estimateCacheState({
      observations: all,
      baseUrl: this.baseUrlHint,
    });
    this.recordStateTransition(session.sessionId, estimate, all);
    return { session, snapshotObservations: snapshotObs, allObservations: all, estimate };
  }

  /**
   * Re-estimate from observations already in memory (no file I/O) — used by
   * watch-mode ticks, where only time advances between appends.
   */
  reestimate(session: DiscoveredSession, observations: CacheObservation[]): SessionStatus {
    const estimate = estimateCacheState({
      observations,
      baseUrl: this.baseUrlHint,
    });
    this.recordStateTransition(session.sessionId, estimate, observations);
    return { session, snapshotObservations: [], allObservations: observations, estimate };
  }

  /** Live tail from EOF. Returns stop(). onUpdate fires on each new batch. */
  watch(
    session: DiscoveredSession,
    onUpdate: (status: SessionStatus) => void,
    onError?: (err: Error) => void,
  ): { stop: () => void } {
    const parser = new ObservationParser();
    const tailer = new JsonlTailer(session.filePath, {
      startAtEof: true,
      pollMs: 1000,
      onLines: (text) => {
        const fresh = parser.parseBuffer(text, session.filePath);
        if (fresh.length === 0) return;
        const stored = this.store.observationsFor(session.sessionId);
        const all = mergeObservations(stored, fresh);
        this.persist(session, fresh, all);
        const estimate = estimateCacheState({
          observations: all,
          baseUrl: this.baseUrlHint,
        });
        this.recordStateTransition(session.sessionId, estimate, all);
        onUpdate({ session, snapshotObservations: fresh, allObservations: all, estimate });
      },
      onTruncate: () => {
        // Session file rotated/replaced; snapshot fresh state next tick.
        void this.snapshot(session).then(onUpdate).catch(() => {});
      },
    });
    try {
      tailer.start();
    } catch (err) {
      onError?.(err as Error);
      return { stop: () => {} };
    }
    return { stop: () => tailer.stop() };
  }

  private readSnapshot(
    session: DiscoveredSession,
    snapshotBytes: number,
  ): CacheObservation[] {
    let text: string;
    try {
      text = readTailSnapshot(session.filePath, snapshotBytes).text;
    } catch (err) {
      throw new Error(
        `Failed reading session file ${session.filePath}: ${(err as Error).message}`,
      );
    }
    const parser = new ObservationParser();
    return parser.parseBuffer(text, session.filePath);
  }

  private persist(
    session: DiscoveredSession,
    fresh: CacheObservation[],
    all: CacheObservation[],
  ): void {
    const known = this.store.observationCount(session.sessionId);
    this.store.upsertSession({
      sessionId: session.sessionId,
      agent: 'claude-code',
      projectDir: session.projectDir,
      cwd: session.registry?.cwd,
      model: latestModel(all) ?? latestModel(fresh),
      agentVersion: session.registry?.version,
      startedAt: all[0]?.timestamp,
      lastSeen: all[all.length - 1]?.timestamp,
    });
    const addedObs = this.store.insertObservations(fresh);
    if (known === 0 && addedObs.length > 0) {
      this.emitEvent(session.sessionId, all[0]!.timestamp, 'SESSION_STARTED', {
        observations: all.length,
        added: addedObs.length,
      });
    }
    // Facts are emitted once per NEW observation — never replayed on re-snapshot.
    this.recordFactEvents(session.sessionId, addedObs);
  }

  private recordFactEvents(sessionId: string, fresh: CacheObservation[]): void {
    const sorted = [...fresh].sort((a, b) => a.timestamp - b.timestamp);
    for (let i = 0; i < sorted.length; i++) {
      const fact = classifyFact(sorted[i]!, i > 0 ? sorted[i - 1] : undefined);
      if (!fact) continue;
      if (fact.kind === 'HIT') {
        this.emitEvent(sessionId, fact.timestamp, 'VERIFIED_HIT', {
          cacheReadTokens: fact.cacheReadTokens,
          contextTokens: fact.contextTokens,
        });
      } else if (fact.kind === 'MISS') {
        this.emitEvent(sessionId, fact.timestamp, 'VERIFIED_MISS', {
          cacheReadTokens: 0,
          contextTokens: fact.contextTokens,
          cacheWriteTokens: fact.cacheWriteTokens,
        });
      } else {
        this.emitEvent(sessionId, fact.timestamp, 'PARTIAL_MISS', {
          cacheReadTokens: fact.cacheReadTokens,
          contextTokens: fact.contextTokens,
        });
      }
    }
  }

  private recordStateTransition(
    sessionId: string,
    estimate: CacheStateEstimate,
    _all: CacheObservation[],
  ): void {
    const prev = this.lastStateBySession.get(sessionId);
    if (estimate.state === 'AT_RISK' && prev !== 'AT_RISK') {
      this.emitEvent(sessionId, Date.now(), 'TTL_RISK', {
        ttlRemainingMs: estimate.ttlRemainingMs,
        reason: estimate.reason,
      });
    }
    this.lastStateBySession.set(sessionId, estimate.state);
  }

  private emitEvent(
    sessionId: string,
    timestamp: number,
    eventType: CacheEventType,
    detail: Record<string, unknown>,
  ): void {
    const event: CacheEvent = {
      sessionId,
      timestamp,
      eventType,
      detail: JSON.stringify(detail),
    };
    try {
      this.store.insertEvent(event);
    } catch {
      // events are best-effort; never break monitoring on storage hiccups
    }
  }
}

function mergeObservations(
  a: CacheObservation[],
  b: CacheObservation[],
): CacheObservation[] {
  const byKey = new Map<string, CacheObservation>();
  for (const o of [...a, ...b]) byKey.set(`${o.sessionId}:${o.requestId}`, o);
  return [...byKey.values()].sort((x, y) => x.timestamp - y.timestamp);
}

function latestModel(obs: CacheObservation[]): string | undefined {
  for (let i = obs.length - 1; i >= 0; i--) {
    if (obs[i]!.model) return obs[i]!.model;
  }
  return undefined;
}

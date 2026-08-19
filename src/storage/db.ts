/**
 * Local SQLite storage (~/.cacheguard/cacheguard.db by default).
 *
 * Privacy: only token counters, timestamps, model names and session
 * metadata are stored. Never message content, never prompts, never code.
 * The parser physically does not extract content, so nothing can leak here.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import type {
  CacheEvent,
  CacheObservation,
  StoredSession,
} from '../types/index.js';

export function defaultDbPath(): string {
  const override = process.env.CACHEGUARD_DB;
  if (override && override.trim()) return override.trim();
  return path.join(os.homedir(), '.cacheguard', 'cacheguard.db');
}

export class CacheGuardStore {
  private readonly db: Database.Database;

  constructor(dbPath: string = defaultDbPath()) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000'); // concurrent status/watch processes
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id    TEXT PRIMARY KEY,
        agent         TEXT NOT NULL,
        project_dir   TEXT,
        cwd           TEXT,
        model         TEXT,
        agent_version TEXT,
        started_at    INTEGER,
        last_seen     INTEGER,
        updated_at    INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS observations (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id               TEXT NOT NULL REFERENCES sessions(session_id),
        request_id               TEXT NOT NULL,
        timestamp                INTEGER NOT NULL,
        model                    TEXT,
        input_tokens             INTEGER,
        output_tokens            INTEGER,
        cache_read_tokens        INTEGER,
        cache_write_tokens       INTEGER,
        context_tokens           INTEGER,
        five_minute_cache_tokens INTEGER,
        one_hour_cache_tokens    INTEGER,
        partial                  INTEGER NOT NULL DEFAULT 0,
        source                   TEXT,
        agent_version            TEXT,
        UNIQUE(session_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS idx_obs_session_ts ON observations(session_id, timestamp);
      CREATE TABLE IF NOT EXISTS cache_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL,
        timestamp   INTEGER NOT NULL,
        event_type  TEXT NOT NULL,
        detail      TEXT,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_session_ts ON cache_events(session_id, timestamp);
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
    `);
  }

  upsertSession(s: StoredSession): void {
    const existing = this.db
      .prepare(`SELECT * FROM sessions WHERE session_id = ?`)
      .get(s.sessionId) as Record<string, unknown> | undefined;

    const merged: StoredSession = existing
      ? {
          sessionId: s.sessionId,
          agent: s.agent,
          projectDir: s.projectDir ?? (existing.project_dir as string | undefined),
          cwd: s.cwd ?? (existing.cwd as string | undefined),
          model: s.model ?? (existing.model as string | undefined),
          agentVersion: s.agentVersion ?? (existing.agent_version as string | undefined),
          startedAt: pickEarlier(s.startedAt, existing.started_at as number | undefined),
          lastSeen: pickLater(s.lastSeen, existing.last_seen as number | undefined),
        }
      : s;

    this.db
      .prepare(
        `INSERT INTO sessions (session_id, agent, project_dir, cwd, model, agent_version, started_at, last_seen, updated_at)
         VALUES (@sessionId, @agent, @projectDir, @cwd, @model, @agentVersion, @startedAt, @lastSeen, @updatedAt)
         ON CONFLICT(session_id) DO UPDATE SET
           project_dir = excluded.project_dir,
           cwd = excluded.cwd,
           model = excluded.model,
           agent_version = excluded.agent_version,
           started_at = excluded.started_at,
           last_seen = excluded.last_seen,
           updated_at = excluded.updated_at`,
      )
      .run({
        sessionId: merged.sessionId,
        agent: merged.agent,
        projectDir: merged.projectDir ?? null,
        cwd: merged.cwd ?? null,
        model: merged.model ?? null,
        agentVersion: merged.agentVersion ?? null,
        startedAt: merged.startedAt ?? null,
        lastSeen: merged.lastSeen ?? null,
        updatedAt: Date.now(),
      });
  }

  /** Insert new observations; deduped by (session_id, request_id).
   *  Returns only the rows that were actually new. */
  insertObservations(obs: CacheObservation[]): CacheObservation[] {
    if (obs.length === 0) return [];
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO observations
        (session_id, request_id, timestamp, model, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, context_tokens,
         five_minute_cache_tokens, one_hour_cache_tokens, partial, source, agent_version)
       VALUES
        (@sessionId, @requestId, @timestamp, @model, @inputTokens, @outputTokens,
         @cacheReadTokens, @cacheWriteTokens, @contextTokens,
         @fiveMinuteCacheTokens, @oneHourCacheTokens, @partial, @source, @agentVersion)`,
    );
    const tx = this.db.transaction((rows: CacheObservation[]) => {
      const added: CacheObservation[] = [];
      for (const o of rows) {
        const res = stmt.run({
          sessionId: o.sessionId,
          requestId: o.requestId,
          timestamp: o.timestamp,
          model: o.model ?? null,
          inputTokens: o.inputTokens ?? null,
          outputTokens: o.outputTokens ?? null,
          cacheReadTokens: o.cacheReadTokens ?? null,
          cacheWriteTokens: o.cacheWriteTokens ?? null,
          contextTokens: o.contextTokens ?? null,
          fiveMinuteCacheTokens: o.fiveMinuteCacheTokens ?? null,
          oneHourCacheTokens: o.oneHourCacheTokens ?? null,
          partial: o.partial ? 1 : 0,
          source: o.source,
          agentVersion: o.agentVersion ?? null,
        });
        if (res.changes > 0) added.push(o);
      }
      return added;
    });
    return tx(obs) as CacheObservation[];
  }

  insertEvent(e: CacheEvent): void {
    this.db
      .prepare(
        `INSERT INTO cache_events (session_id, timestamp, event_type, detail, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(e.sessionId, e.timestamp, e.eventType, e.detail, Date.now());
  }

  observationsFor(sessionId: string, limit = 500): CacheObservation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM observations WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(sessionId, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToObservation).reverse();
  }

  observationCount(sessionId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM observations WHERE session_id = ?`)
      .get(sessionId) as { n: number };
    return row.n;
  }

  eventsFor(sessionId: string, limit = 100): CacheEvent[] {
    const rows = this.db
      .prepare(
        `SELECT session_id, timestamp, event_type, detail FROM cache_events
         WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(sessionId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      sessionId: String(r.session_id),
      timestamp: Number(r.timestamp),
      eventType: String(r.event_type) as CacheEvent['eventType'],
      detail: String(r.detail ?? ''),
    }));
  }

  listSessions(): StoredSession[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions ORDER BY last_seen DESC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      sessionId: String(r.session_id),
      agent: 'claude-code',
      projectDir: (r.project_dir as string | undefined) ?? undefined,
      cwd: (r.cwd as string | undefined) ?? undefined,
      model: (r.model as string | undefined) ?? undefined,
      agentVersion: (r.agent_version as string | undefined) ?? undefined,
      startedAt: (r.started_at as number | undefined) ?? undefined,
      lastSeen: (r.last_seen as number | undefined) ?? undefined,
    }));
  }

  close(): void {
    this.db.close();
  }
}

function pickEarlier(a?: number, b?: number): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

function pickLater(a?: number, b?: number): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

function rowToObservation(r: Record<string, unknown>): CacheObservation {
  const orNull = (v: unknown): number | undefined =>
    v === null || v === undefined ? undefined : Number(v);
  return {
    timestamp: Number(r.timestamp),
    agent: 'claude-code',
    sessionId: String(r.session_id),
    requestId: String(r.request_id),
    model: (r.model as string) ?? undefined,
    inputTokens: orNull(r.input_tokens),
    outputTokens: orNull(r.output_tokens),
    cacheReadTokens: orNull(r.cache_read_tokens),
    cacheWriteTokens: orNull(r.cache_write_tokens),
    contextTokens: orNull(r.context_tokens),
    fiveMinuteCacheTokens: orNull(r.five_minute_cache_tokens),
    oneHourCacheTokens: orNull(r.one_hour_cache_tokens),
    partial: Number(r.partial) === 1,
    source: String(r.source ?? ''),
    agentVersion: (r.agent_version as string) ?? undefined,
  };
}

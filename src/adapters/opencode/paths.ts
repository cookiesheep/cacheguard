/**
 * Locating OpenCode data on disk.
 *
 * Real-data audited 2026-08-20, opencode 1.3.17 (docs/opencode-schema.md):
 *   ~/.local/share/opencode/opencode.db   ← session/message history (SQLite,
 *                                           drizzle migrations; readonly here)
 *   ~/.local/share/opencode/storage/      ← plugin state only in 1.3.x
 *   ~/.config/opencode/                   ← config (never read by CacheGuard)
 *
 * OpenCode honors XDG_DATA_HOME; on this Windows machine it still uses
 * ~/.local/share/opencode. $OPENCODE_DATA overrides in OpenCode itself are
 * not documented — env override below is CacheGuard's escape hatch.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

export function opencodeDataDir(override?: string | undefined): string {
  if (override) return override;
  const env = process.env.CACHEGUARD_OPENCODE_DIR ?? process.env.XDG_DATA_HOME;
  if (env && env.trim() && fs.existsSync(path.join(env.trim(), 'opencode'))) {
    return path.join(env.trim(), 'opencode');
  }
  return path.join(os.homedir(), '.local', 'share', 'opencode');
}

export function opencodeDbPath(override?: string | undefined): string {
  return path.join(opencodeDataDir(override), 'opencode.db');
}

export interface OpenCodeSessionRow {
  id: string;
  directory?: string | undefined;
  title?: string | undefined;
  time_created?: number | undefined;
  time_updated?: number | undefined;
}

/** List sessions from the DB, newest first. Empty array when DB absent. */
export function listOpenCodeSessions(override?: string | undefined): OpenCodeSessionRow[] {
  const dbFile = opencodeDbPath(override);
  if (!fs.existsSync(dbFile)) return [];
  const Database = loadDriver();
  const db = new Database(dbFile, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT id, directory, title, time_created, time_updated FROM session
         ORDER BY COALESCE(time_updated, time_created) DESC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      directory: (r.directory as string | undefined) ?? undefined,
      title: (r.title as string | undefined) ?? undefined,
      time_created: (r.time_created as number | undefined) ?? undefined,
      time_updated: (r.time_updated as number | undefined) ?? undefined,
    }));
  } finally {
    db.close();
  }
}

export interface OpenCodeMessageRow {
  id: string;
  time_created: number;
  data: string;
}

/**
 * Assistant messages with token usage for one session, oldest first.
 * `limitRows` bounds the read (tail semantics for status; Infinity for the
 * deterministic full ledger — F4 rule).
 */
export function readOpenCodeMessages(
  sessionId: string,
  opts: { limitRows?: number | undefined; dirOverride?: string | undefined } = {},
): OpenCodeMessageRow[] {
  const dbFile = opencodeDbPath(opts.dirOverride);
  if (!fs.existsSync(dbFile)) return [];
  const Database = loadDriver();
  const db = new Database(dbFile, { readonly: true });
  try {
    const limit = Math.max(1, Math.floor(opts.limitRows ?? 10_000));
    const rows = db
      .prepare(
        `SELECT id, time_created, data FROM message
         WHERE session_id = ? AND data LIKE '%"tokens"%' AND data LIKE '%"assistant"%'
         ORDER BY time_created ASC LIMIT ?`,
      )
      .all(sessionId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      time_created: Number(r.time_created),
      data: String(r.data),
    }));
  } finally {
    db.close();
  }
}

/** Lazy native driver load — statusline and non-DB paths must not pay for it. */
function loadDriver(): typeof import('better-sqlite3') {
  const req = createRequire(import.meta.url);
  return req('better-sqlite3') as typeof import('better-sqlite3');
}

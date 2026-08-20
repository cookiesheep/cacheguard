/**
 * OpenCodeAdapter — discovery from the opencode SQLite DB.
 * No live registry; session.time_updated is the activity signal.
 */
import type { AgentAdapter, DiscoveredSession } from '../../types/index.js';
import { listOpenCodeSessions, opencodeDbPath } from './paths.js';

export class OpenCodeAdapter implements AgentAdapter {
  readonly kind = 'opencode' as const;

  constructor(private readonly dirOverride?: string | undefined) {}

  async discoverSessions(_maxAgeDays?: number | undefined): Promise<DiscoveredSession[]> {
    const sessions = listOpenCodeSessions(this.dirOverride);
    const dbFile = opencodeDbPath(this.dirOverride);
    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(dbFile).size;
    } catch {
      /* db vanished */
    }
    return sessions.map((s) => ({
      agent: 'opencode',
      sessionId: s.id,
      filePath: dbFile, // ingestion queries the DB, not a JSONL tail
      projectDir: s.directory ?? 'opencode',
      sizeBytes,
      modifiedAt: s.time_updated ?? s.time_created ?? 0,
    }));
  }
}

import fs from 'node:fs';

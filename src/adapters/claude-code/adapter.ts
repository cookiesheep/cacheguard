/**
 * ClaudeCodeAdapter — session discovery for ~/.claude/projects.
 *
 * Ranking: a live registry entry (updatedAt) beats raw file mtime, because
 * the registry is written by the running Claude Code process itself.
 * Registry files can outlive their process, so freshness is advisory only.
 */
import type {
  AgentAdapter,
  DiscoveredSession,
} from '../../types/index.js';
import {
  readSessionRegistry,
  scanSessionFiles,
} from './paths.js';

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly kind = 'claude-code' as const;

  constructor(private readonly dirOverride?: string | undefined) {}

  async discoverSessions(maxAgeDays?: number): Promise<DiscoveredSession[]> {
    const registry = readSessionRegistry(this.dirOverride);
    const files = scanSessionFiles(this.dirOverride, maxAgeDays);
    const sessions: DiscoveredSession[] = files.map((f) => ({
      agent: 'claude-code',
      sessionId: f.sessionId,
      filePath: f.filePath,
      projectDir: f.projectDir,
      sizeBytes: f.sizeBytes,
      modifiedAt: f.modifiedAt,
      registry: registry.get(f.sessionId),
    }));
    sessions.sort((a, b) => activityScore(b) - activityScore(a));
    return sessions;
  }
}

/** Best-guess "how active is this session" score (epoch ms of last signal). */
function activityScore(s: DiscoveredSession): number {
  const signals = [s.modifiedAt, s.registry?.updatedAt ?? 0];
  return Math.max(...signals);
}

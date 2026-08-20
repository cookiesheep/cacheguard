/**
 * CodexAdapter — session discovery for ~/.codex.
 * No live registry exists for Codex (unlike Claude Code's sessions/<pid>.json);
 * file mtime is the only activity signal.
 */
import type {
  AgentAdapter,
  DiscoveredSession,
} from '../../types/index.js';
import { scanCodexSessions } from './paths.js';

export class CodexAdapter implements AgentAdapter {
  readonly kind = 'codex' as const;

  constructor(private readonly dirOverride?: string | undefined) {}

  async discoverSessions(maxAgeDays?: number | undefined): Promise<DiscoveredSession[]> {
    const scan = scanCodexSessions(this.dirOverride, maxAgeDays);
    return scan.files.map((f) => ({
      agent: 'codex',
      sessionId: f.sessionId,
      filePath: f.filePath,
      projectDir: f.projectDir,
      sizeBytes: f.sizeBytes,
      modifiedAt: f.modifiedAt,
    }));
  }
}

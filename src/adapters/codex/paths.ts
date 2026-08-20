/**
 * Locating Codex CLI data on disk.
 *
 * Layout (real-data audited 2026-08-20, codex-cli 0.147.0 — see
 * docs/codex-schema.md; no official format docs exist, facts standard is
 * the openai/codex Rust serde definitions):
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<conversation_id>.jsonl
 *   ~/.codex/archived_sessions/rollout-<ts>-<conversation_id>.jsonl
 *   $CODEX_HOME overrides ~/.codex
 *   some deployments zstd-compress rollouts (*.zst or magic bytes) — skipped
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface CodexFile {
  filePath: string;
  /** Conversation id from the filename (uuid after the timestamp). */
  sessionId: string;
  /** Directory relative to the sessions root (e.g. "2026/08/19") or "archived". */
  projectDir: string;
  sizeBytes: number;
  modifiedAt: number;
}

export interface CodexScanResult {
  files: CodexFile[];
  /** zstd-compressed rollouts found and skipped (not an error). */
  skippedZstd: number;
}

export function codexHome(override?: string | undefined): string {
  if (override) return override;
  const env = process.env.CODEX_HOME;
  if (env && env.trim()) return env.trim();
  return path.join(os.homedir(), '.codex');
}

/** zstd frame magic (0x28 B5 2F FD) — catches renamed/misnamed archives too. */
export function isZstdFile(filePath: string): boolean {
  if (filePath.endsWith('.zst') || filePath.endsWith('.zstd')) return true;
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(4);
      const n = fs.readSync(fd, buf, 0, 4, 0);
      return n === 4 && buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

const ROLLOUT_ID = /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Recursively scan sessions/ (date-nested) + archived_sessions/. Never throws. */
export function scanCodexSessions(
  dirOverride?: string | undefined,
  maxAgeDays?: number | undefined,
): CodexScanResult {
  const root = codexHome(dirOverride);
  const cutoff = maxAgeDays ? Date.now() - maxAgeDays * 86_400_000 : undefined;
  const result: CodexScanResult = { files: [], skippedZstd: 0 };

  const consider = (filePath: string, projectDir: string) => {
    if (isZstdFile(filePath)) {
      result.skippedZstd++;
      return;
    }
    const m = filePath.match(ROLLOUT_ID);
    if (!m) return;
    try {
      const st = fs.statSync(filePath);
      if (cutoff && st.mtimeMs < cutoff) return;
      result.files.push({
        filePath,
        sessionId: m[1]!,
        projectDir,
        sizeBytes: st.size,
        modifiedAt: st.mtimeMs,
      });
    } catch {
      /* vanished mid-scan */
    }
  };

  const walk = (dir: string, rel: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth < 6) walk(full, relPath, depth + 1);
      } else if (entry.name.endsWith('.jsonl') || entry.name.endsWith('.zst')) {
        consider(full, rel || 'archived');
      }
    }
  };

  walk(path.join(root, 'sessions'), '', 0);
  walk(path.join(root, 'archived_sessions'), '', 0);

  result.files.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return result;
}

/**
 * Locating Claude Code data on disk.
 *
 * Layout (audited 2026-08-19, Claude Code 2.1.235 — see docs/claude-code-schema.md):
 *   ~/.claude/projects/<munged-cwd>/<sessionId>.jsonl
 *   ~/.claude/projects/<munged-cwd>/<sessionId>/subagents/agent-*.jsonl
 *   ~/.claude/sessions/<pid>.json        live-session registry
 *   ~/.claude/settings.json              may set ANTHROPIC_BASE_URL (provider hint)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SessionRegistryEntry } from '../../types/index.js';

export function claudeDir(override?: string | undefined): string {
  if (override) return override;
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env && env.trim()) return env.trim();
  return path.join(os.homedir(), '.claude');
}

export function projectsDir(override?: string | undefined): string {
  return path.join(claudeDir(override), 'projects');
}

export function registryDir(override?: string | undefined): string {
  return path.join(claudeDir(override), 'sessions');
}

export function settingsPath(override?: string | undefined): string {
  return path.join(claudeDir(override), 'settings.json');
}

export interface JsonlFile {
  filePath: string;
  projectDir: string;
  sessionId: string;
  sizeBytes: number;
  modifiedAt: number;
}

/** Scan all project dirs for session JSONL files. Never throws on weird dirs. */
export function scanSessionFiles(dirOverride?: string | undefined, maxAgeDays?: number | undefined): JsonlFile[] {
  const root = projectsDir(dirOverride);
  let projectDirs: string[];
  try {
    projectDirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const cutoff = maxAgeDays ? Date.now() - maxAgeDays * 86_400_000 : undefined;
  const files: JsonlFile[] = [];
  for (const dir of projectDirs) {
    const dirPath = path.join(root, dir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const filePath = path.join(dirPath, entry.name);
      try {
        const st = fs.statSync(filePath);
        if (cutoff && st.mtimeMs < cutoff) continue;
        files.push({
          filePath,
          projectDir: dir,
          sessionId: entry.name.replace(/\.jsonl$/, ''),
          sizeBytes: st.size,
          modifiedAt: st.mtimeMs,
        });
      } catch {
        /* file vanished mid-scan */
      }
    }
  }
  return files;
}

/** Read the live-session registry. Missing dir (older Claude Code) → empty map. */
export function readSessionRegistry(dirOverride?: string | undefined): Map<string, SessionRegistryEntry> {
  const result = new Map<string, SessionRegistryEntry>();
  const dir = registryDir(dirOverride);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, entry.name), 'utf8'));
      if (raw && typeof raw.sessionId === 'string') {
        result.set(raw.sessionId, {
          pid: typeof raw.pid === 'number' ? raw.pid : -1,
          sessionId: raw.sessionId,
          cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
          startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : undefined,
          status: typeof raw.status === 'string' ? raw.status : undefined,
          updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : undefined,
          version: typeof raw.version === 'string' ? raw.version : undefined,
          name: typeof raw.name === 'string' ? raw.name : undefined,
          entrypoint: typeof raw.entrypoint === 'string' ? raw.entrypoint : undefined,
        });
      }
    } catch {
      /* registry files are advisory; ignore bad ones */
    }
  }
  return result;
}

/**
 * Provider hint from settings.json. Reads ONLY env.ANTHROPIC_BASE_URL —
 * never auth tokens, never anything else. Missing/unreadable → undefined.
 */
export function readBaseUrlHint(dirOverride?: string | undefined): string | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(dirOverride), 'utf8'));
    const url = raw?.env?.ANTHROPIC_BASE_URL;
    return typeof url === 'string' && url.trim() ? url.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** True when the configured base URL is Anthropic itself (native TTL policy applies). */
export function isNativeAnthropic(baseUrl?: string | undefined): boolean {
  if (!baseUrl) return true; // default endpoint
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'api.anthropic.com' || host.endsWith('.anthropic.com');
  } catch {
    return false;
  }
}

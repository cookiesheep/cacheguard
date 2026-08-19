#!/usr/bin/env node
/**
 * Schema audit tool — regenerates the facts behind docs/claude-code-schema.md.
 *
 * Usage:
 *   node scripts/schema-audit.mjs [path/to/session.jsonl]
 *   node scripts/schema-audit.mjs --recent      (newest file under ~/.claude/projects)
 *
 * Reads only structure: record types, key sets, usage field frequency.
 * Never prints message content, paths aside.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function findTarget(fileArg) {
  if (fileArg && fileArg !== '--recent') return fileArg;
  const root = path.join(os.homedir(), '.claude', 'projects');
  let best = null;
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(root, dir.name), { withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const full = path.join(root, dir.name, f.name);
      const mtime = fs.statSync(full).mtimeMs;
      if (!best || mtime > best.mtime) best = { full, mtime };
    }
  }
  if (!best) throw new Error('no session files found');
  return best.full;
}

const target = findTarget(process.argv[2]);
const text = fs.readFileSync(target, 'utf8');
const lines = text.split('\n').filter(Boolean);

const types = {};
const usageKeys = {};
const models = {};
let withUsage = 0;
let withoutUsage = 0;
let synthetic = 0;
let missingCacheField = 0;
let parseErrors = 0;
let sidechain = 0;
const messageIds = new Set();

for (const line of lines) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    parseErrors++;
    continue;
  }
  types[o.type] = (types[o.type] ?? 0) + 1;
  if (o.isSidechain) sidechain++;
  if (o.type !== 'assistant' || !o.message) continue;
  models[o.message.model ?? '<none>'] = (models[o.message.model ?? '<none>'] ?? 0) + 1;
  if (o.message.model === '<synthetic>') {
    synthetic++;
    continue;
  }
  const u = o.message.usage;
  if (!u) {
    withoutUsage++;
    continue;
  }
  withUsage++;
  if (o.message.id) messageIds.add(o.message.id);
  for (const k of Object.keys(u)) usageKeys[k] = (usageKeys[k] ?? 0) + 1;
  if (!('cache_read_input_tokens' in u)) missingCacheField++;
}

console.log(`file: ${target}`);
console.log(`lines: ${lines.length} (parse errors: ${parseErrors}, sidechain: ${sidechain})`);
console.log(`record types: ${JSON.stringify(types)}`);
console.log(`models: ${JSON.stringify(models)}`);
console.log(`assistant-with-usage: ${withUsage} (without: ${withoutUsage}, synthetic: ${synthetic})`);
console.log(`usage field frequency: ${JSON.stringify(usageKeys)}`);
console.log(
  `usage missing cache_read_input_tokens: ${missingCacheField}; unique message.id: ${messageIds.size} (dup factor ${(withUsage / Math.max(1, messageIds.size)).toFixed(2)}x)`,
);

#!/usr/bin/env node
/**
 * Pre-publish install smoke test (repeatable):
 *   1. npm pack the repo
 *   2. install the tarball into a scratch project (no global side effects)
 *   3. build a minimal fixture HOME (~/.claude + ~/.codex structures)
 *   4. run the full command surface against it (sessions/status/cost/doctor,
 *      watch --help, --json) and assert key output
 *   5. verify tarball contents (dist included, LICENSE shipped)
 *
 * Exit code 0 = smoke passed.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'cacheguard-smoke-'));

function run(cmd, args, opts = {}) {
  // npm is npm.cmd on Windows and Node ≥24 refuses .cmd without a shell;
  // paths used here contain no spaces, so shell-joining is safe.
  if (process.platform === 'win32' && cmd === 'npm') {
    return execFileSync(`${cmd} ${args.join(' ')}`, {
      shell: true,
      encoding: 'utf8',
      timeout: 120_000,
      ...opts,
    });
  }
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: 120_000, ...opts });
}

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

console.log(`scratch: ${SCRATCH}`);

// ---- 1. pack ----
const tarball = run('npm', ['pack', '--json'], { cwd: ROOT });
const packInfo = JSON.parse(tarball);
const tarPath = path.join(ROOT, packInfo[0].filename);
console.log(`packed: ${packInfo[0].filename} (${packInfo[0].size} bytes)`);

const fileList = packInfo[0].files.map((f) => f.path);
check('tarball includes dist/cli/index.js', fileList.some((f) => f.replaceAll('\\', '/').includes('dist/cli/index.js')));
check('tarball includes LICENSE', fileList.some((f) => f.replace(/\\/g, '/').endsWith('LICENSE')));
check('tarball excludes src/', !fileList.some((f) => f.startsWith('src/')));
check('tarball excludes tests/', !fileList.some((f) => f.startsWith('tests/')));

// ---- 2. install into scratch project ----
const proj = path.join(SCRATCH, 'proj');
fs.mkdirSync(proj);
run('npm', ['install', tarPath], { cwd: proj });
const bin = path.join(proj, 'node_modules', '.bin', process.platform === 'win32' ? 'cacheguard.cmd' : 'cacheguard');
check('bin installed', fs.existsSync(bin));

const PKG_DIR = path.join(proj, 'node_modules', '@cookiesheep', 'cacheguard');
const entry = fs.readFileSync(path.join(PKG_DIR, 'dist', 'cli', 'index.js'), 'utf8');
check('bin entry has node shebang', entry.startsWith('#!/usr/bin/env node'));

function cg(args, expectOk = true) {
  try {
    return run('node', [path.join(PKG_DIR, 'dist', 'cli', 'index.js'), ...args], {
      env: { ...process.env, CACHEGUARD_DB: path.join(SCRATCH, 'smoke.db') },
    });
  } catch (e) {
    if (expectOk) {
      failures++;
      console.error(`  FAIL command "${args.join(' ')}" — ${e.message}`);
    }
    return String(e.stdout ?? '');
  }
}

// ---- 3. fixture HOME ----
const home = path.join(SCRATCH, 'home');
const claudeProj = path.join(home, 'claude', 'projects', 'D--smoke-demo');
fs.mkdirSync(claudeProj, { recursive: true });
fs.copyFileSync(
  path.join(ROOT, 'tests', 'fixtures', 'session-basic.jsonl'),
  path.join(claudeProj, '019smoke00-0000-4000-8000-000000000001.jsonl'),
);
const codexDay = path.join(home, 'codex', 'sessions', '2026', '08', '20');
fs.mkdirSync(codexDay, { recursive: true });
fs.copyFileSync(
  path.join(ROOT, 'tests', 'fixtures', 'codex', 'session-basic.jsonl'),
  path.join(codexDay, 'rollout-2026-08-20T10-00-00-019ab0de-0000-4000-8000-000000000002.jsonl'),
);
const commonArgs = ['--claude-dir', path.join(home, 'claude'), '--codex-dir', path.join(home, 'codex')];

console.log('\ncommand surface:');
// ---- 4. full command surface ----
const sessions = cg(['sessions', ...commonArgs]);
check('sessions lists both agents', sessions.includes('claude-code') && sessions.includes('codex'), sessions.slice(0, 200));

const status = cg(['status', '019ab0de', ...commonArgs]);
check('status (codex) shows agent + model', status.includes('Codex') && /gpt-5\.\d/.test(status));
check('status shows a cache state', /LIKELY_|VERIFIED_|UNKNOWN|AT_RISK/.test(status));

const statusJson = cg(['status', '019ab0de', '--json', ...commonArgs]);
let parsed = null;
try {
  parsed = JSON.parse(statusJson);
} catch {}
check('status --json parses', parsed !== null);
check('status --json has agent field', parsed?.agent === 'codex');

const cost = cg(['cost', '019ab0de', ...commonArgs]);
check('cost shows verified bleed line', cost.includes('Cache Bleed (verified)'));
check('cost shows full-file coverage', cost.includes('full session file'));

const costJson = cg(['cost', '019ab0de', '--json', ...commonArgs]);
let costParsed = null;
try {
  costParsed = JSON.parse(costJson);
} catch {}
check('cost --json parses with verified ledger', costParsed?.verified !== undefined);

const doctor = cg(['doctor', '019ab0de', ...commonArgs]);
check('doctor shows attribution or clean message', doctor.includes('Attribution breakdown') || doctor.includes('No verified MISS/PARTIAL'));
check('doctor prints privacy note', doctor.includes('metadata-only'));

const claudeStatus = cg(['status', '019smoke00', ...commonArgs]);
check('status (claude-code fixture) works', claudeStatus.includes('Claude Code'));

const watchHelp = cg(['watch', '--help'], true);
check('watch --help is English and current', watchHelp.includes('live-refreshing cache status'));

const help = cg(['--help']);
check('top --help mentions both agents', help.includes('Claude Code + Codex'));
check('--help has no stale Phase-1 text', !help.includes('Phase 1: Claude Code'));

const version = cg(['--version']);
check('--version prints', /^\d+\.\d+\.\d+/.test(version.trim()));

// ---- 5. summary ----
console.log(failures === 0 ? '\nSMOKE PASSED ✅' : `\nSMOKE FAILED ❌ (${failures} check(s))`);
try {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.rmSync(tarPath, { force: true });
} catch {}
process.exit(failures === 0 ? 0 : 1);

/**
 * Full CLI (commander setup). Loaded lazily from index.ts for every command
 * except `statusline` (which takes a lightweight path).
 */
import { Command } from 'commander';
import { SessionEngine } from '../sessions/engine.js';
import { computeCostLedger, type CostLedger } from '../cost/engine.js';
import { analyzeDoctor, type DoctorReport } from '../doctor/analyze.js';
import { renderStatusline } from './statusline.js';
import {
  renderStatus,
  fmtTokens,
  fmtDuration,
  fmtTime,
  colorState,
  beginRedraw,
} from './format.js';
import type { DiscoveredSession } from '../types/index.js';

const program = new Command();

program
  .name('cacheguard')
  .description('Read-only prompt-cache observability for coding agents (Claude Code + Codex)')
  .version('0.1.0')
  .option('--no-color', 'disable ANSI colors')
  .option('--claude-dir <path>', 'override ~/.claude location')
  .option('--codex-dir <path>', 'override ~/.codex location');

function colorEnabled(opts: { color?: boolean }): boolean {
  return opts.color !== false && process.stdout.isTTY === true;
}

async function pickSession(
  engine: SessionEngine,
  sessionArg?: string,
): Promise<DiscoveredSession> {
  const sessions = await engine.discover();
  if (sessions.length === 0) {
    throw new Error(
      'No Claude Code sessions found under ~/.claude/projects. Has Claude Code been used on this machine?',
    );
  }
  if (!sessionArg) return sessions[0]!;
  const byId = sessions.find(
    (s) =>
      s.sessionId === sessionArg ||
      s.sessionId.startsWith(sessionArg) ||
      s.filePath === sessionArg,
  );
  if (!byId) {
    const known = sessions.slice(0, 10).map((s) => `  ${s.sessionId}`).join('\n');
    throw new Error(`Session not found: ${sessionArg}\nMost recent sessions:\n${known}`);
  }
  return byId;
}

program
  .command('status')
  .description('one-shot cache status of the most recent session')
  .argument('[sessionId]', 'session id (prefix match) or file path')
  .option('--snapshot-bytes <n>', 'bytes of the session tail to parse', '4194304')
  .option('--json', 'machine-readable output')
  .action(async (sessionId: string | undefined, cmdOpts: Record<string, unknown>) => {
    const globals = program.opts() as { claudeDir?: string; codexDir?: string };
    const engine = new SessionEngine({
      claudeDirOverride: globals.claudeDir,
      codexDirOverride: globals.codexDir,
    });
    try {
      const session = await pickSession(engine, sessionId);
      const snapshotBytes = Number(cmdOpts.snapshotBytes ?? 4194304);
      const status = await engine.snapshot(session, snapshotBytes);
      if (cmdOpts.json) {
        const { estimate, allObservations } = status;
        const latest = allObservations[allObservations.length - 1];
        console.log(
          JSON.stringify(
            {
              agent: session.agent,
              session: session.sessionId,
              model: latest?.model,
              contextTokens: latest?.contextTokens,
              cacheReadTokens: latest?.cacheReadTokens,
              cacheWriteTokens: latest?.cacheWriteTokens,
              lastCallAt: latest?.timestamp,
              observations: allObservations.length,
              cacheState: estimate.state,
              confidence: estimate.confidence,
              reason: estimate.reason,
              ttl: estimate.ttl,
              ttlRemainingMs: estimate.ttlRemainingMs,
            },
            null,
            2,
          ),
        );
      } else {
        const ledger = computeCostLedger({
          agent: session.agent,
          observations: status.allObservations,
        });
        let bleedLine: string | undefined;
        if (ledger.verified.entries.length > 0) {
          const amt =
            ledger.pricingStatus.kind === 'priced' && ledger.verified.bleedUsd !== undefined
              ? '$' + ledger.verified.bleedUsd.toFixed(ledger.verified.bleedUsd < 0.1 ? 4 : 2)
              : fmtTokens(ledger.verified.lostContextTokens) + ' tok';
          bleedLine = `Cache bleed (verified): ${amt}  ${ledger.verified.entries.length} events`;
        }
        console.log(renderStatus(status, { color: colorEnabled(program.opts()), bleedLine }));
      }
    } finally {
      engine.store.close();
    }
  });

program
  .command('watch')
  .description('live-refreshing cache status (Ctrl+C to exit)')
  .argument('[sessionId]', 'session id (prefix match) or file path')
  .option('--interval <ms>', 're-render interval', '1000')
  .action(async (sessionId: string | undefined, cmdOpts: Record<string, unknown>) => {
    const globals = program.opts() as { claudeDir?: string; codexDir?: string };
    const engine = new SessionEngine({
      claudeDirOverride: globals.claudeDir,
      codexDirOverride: globals.codexDir,
    });
    let first = true;
    let current: Parameters<typeof renderStatus>[0] | null = null;
    const render = (status: Parameters<typeof renderStatus>[0]) => {
      current = status;
      beginRedraw(first);
      first = false;
      console.log(renderStatus(status, { color: colorEnabled(program.opts()) }));
      console.log('\x1b[2mwatching… Ctrl+C to exit\x1b[0m');
    };
    try {
      const session = await pickSession(engine, sessionId);
      const status = await engine.snapshot(session);
      render(status);
      engine.watch(
        session,
        (s) => render(s),
        (err) => console.error(`watch error: ${err.message}`),
      );
      // TTL countdown advances with time, not only with new lines.
      const interval = Number(cmdOpts.interval ?? 1000);
      setInterval(() => {
        if (current) render(engine.reestimate(session, current.allObservations));
      }, Math.max(250, interval));
    } catch (err) {
      console.error((err as Error).message);
      engine.store.close();
      process.exitCode = 1;
    }
    process.on('SIGINT', () => {
      engine.store.close();
      process.exit(0);
    });
  });

program
  .command('sessions')
  .description('list discovered sessions, most recent first')
  .action(async () => {
    const globals = program.opts() as { claudeDir?: string; codexDir?: string };
    const engine = new SessionEngine({
      claudeDirOverride: globals.claudeDir,
      codexDirOverride: globals.codexDir,
    });
    try {
      const sessions = await engine.discover();
      if (sessions.length === 0) {
        console.log('No sessions found.');
        return;
      }
      console.log('AGENT        SESSION                               PROJECT                        REGISTRY     LAST ACTIVITY');
      for (const s of sessions.slice(0, 25)) {
        const activity = Math.max(s.modifiedAt, s.registry?.updatedAt ?? 0);
        const ago = fmtDuration(Date.now() - activity);
        console.log(
          [
            s.agent.padEnd(13),
            s.sessionId.slice(0, 36).padEnd(37),
            s.projectDir.slice(0, 30).padEnd(31),
            (s.registry?.status ?? '—').padEnd(12),
            `${fmtTime(activity)} (${ago} ago)`,
          ].join(''),
        );
      }
    } finally {
      engine.store.close();
    }
  });

program
  .command('events')
  .description('recent cache events for a session')
  .argument('[sessionId]', 'session id (defaults to most recent discovered)')
  .action(async (sessionId: string | undefined) => {
    const globals = program.opts() as { claudeDir?: string; codexDir?: string };
    const engine = new SessionEngine({
      claudeDirOverride: globals.claudeDir,
      codexDirOverride: globals.codexDir,
    });
    try {
      const session = await pickSession(engine, sessionId);
      const events = engine.store.eventsFor(session.sessionId, 50);
      if (events.length === 0) {
        console.log('No events recorded yet — run `cacheguard status` first.');
        return;
      }
      console.log(`Cache events — ${session.sessionId}`);
      for (const e of [...events].reverse()) {
        const colored = colorEnabled(program.opts()) ? colorState(e.eventType) : e.eventType;
        console.log(`${fmtTime(e.timestamp)}  ${colored.padEnd(20)} ${shorten(e.detail, 80)}`);
      }
    } finally {
      engine.store.close();
    }
  });

program
  .command('cost')
  .description('economic ledger for a session: verified cache bleed, savings, cold exposure')
  .argument('[sessionId]', 'session id (prefix match); defaults to most recent')
  .option('--all', 'aggregate view across all sessions in the local DB')
  .option('--json', 'machine-readable output')
  .action(async (sessionId: string | undefined, cmdOpts: Record<string, unknown>) => {
    const globals = program.opts() as { claudeDir?: string; codexDir?: string };
    const engine = new SessionEngine({
      claudeDirOverride: globals.claudeDir,
      codexDirOverride: globals.codexDir,
    });
    try {
      if (cmdOpts.all) {
        await runCostAll(engine, cmdOpts.json as boolean | undefined);
        return;
      }
      const session = await pickSession(engine, sessionId);
      // F4: ledgers are ALWAYS computed from the FULL session file — a
      // financial report must not depend on how much happens to be cached
      // in the local DB from earlier shallow reads.
      const status = await engine.snapshot(session, Number.MAX_SAFE_INTEGER);
      const ledger = computeCostLedger({
        agent: session.agent,
        observations: status.allObservations,
      });
      if (cmdOpts.json) {
        console.log(JSON.stringify({ session: session.sessionId, ...ledger }, null, 2));
      } else {
        console.log(renderLedger(ledger, session.sessionId, colorEnabled(program.opts())));
      }
    } finally {
      engine.store.close();
    }
  });

program
  .command('doctor')
  .description('attribution diagnosis: why cache misses happened, with evidence-tied advice')
  .argument('[sessionId]', 'session id (prefix match); defaults to most recent')
  .option('--json', 'machine-readable output')
  .action(async (sessionId: string | undefined, cmdOpts: Record<string, unknown>) => {
    const globals = program.opts() as { claudeDir?: string; codexDir?: string };
    const engine = new SessionEngine({
      claudeDirOverride: globals.claudeDir,
      codexDirOverride: globals.codexDir,
    });
    try {
      const session = await pickSession(engine, sessionId);
      // F4: same determinism rule as cost — always the full session file.
      const status = await engine.snapshot(session, Number.MAX_SAFE_INTEGER);
      const report = analyzeDoctor({
        sessionId: session.sessionId,
        agent: session.agent,
        observations: status.allObservations,
      });
      if (cmdOpts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(renderDoctor(report, colorEnabled(program.opts())));
      }
    } finally {
      engine.store.close();
    }
  });

program
  .command('statusline')
  .description('Claude Code statusline integration (reads the status JSON on stdin, prints one line)')
  .action(async () => {
    const { runStatuslineFast } = await import('./statusline.js');
    await runStatuslineFast();
  });

program
  .command('backfill')
  .description('parse a full session file into the local DB (bounded memory, line-by-line)')
  .argument('<sessionId|path>', 'session id (prefix match) or JSONL path')
  .action(async (sessionArg: string) => {
    const globals = program.opts() as { claudeDir?: string; codexDir?: string };
    const engine = new SessionEngine({
      claudeDirOverride: globals.claudeDir,
      codexDirOverride: globals.codexDir,
    });
    try {
      const session = await pickSession(engine, sessionArg);
      const status = await engine.snapshot(session, Number.MAX_SAFE_INTEGER);
      const { snapshotObservations: obs, estimate } = status;
      const reads = obs.filter((o) => (o.cacheReadTokens ?? 0) > 0).length;
      console.log(`Backfilled ${obs.length} observations (${reads} with cache reads).`);
      console.log(`Latest state: ${estimate.state} (${Math.round(estimate.confidence * 100)}%).`);
      console.log(`Context now: ${fmtTokens(obs[obs.length - 1]?.contextTokens)} tok.`);
    } finally {
      engine.store.close();
    }
  });

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
});

function shorten(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

const ATTR_LABEL: Record<string, string> = {
  'suspected-ttl': 'suspected TTL',
  compaction: 'compaction',
  'suspected-prefix-break': 'suspected prefix break',
  unknown: 'unknown',
};

function fmtUsd(v: number | undefined): string {
  if (v === undefined) return '—';
  return '$' + v.toFixed(v < 0.1 && v > 0 ? 4 : 2);
}

export function renderLedger(ledger: CostLedger, sessionId: string, color: boolean): string {
  const dim = (s: string) => (color ? `[2m${s}[0m` : s);
  const bold = (s: string) => (color ? `[1m${s}[0m` : s);
  const L: string[] = [];
  const t = ledger.totals;
  const priced = ledger.pricingStatus.kind === 'priced';
  const quota = ledger.pricingStatus.kind === 'quota';
  L.push(bold('CacheGuard cost') + dim(` — pricing snapshot ${ledger.snapshotDate}`));
  L.push(`Session        ${sessionId}`);
  L.push(`Agent          ${ledger.agent}  ${dim(ledger.totals.models.join(', ').slice(0, 50))}`);
  L.push('');
  L.push(`Requests       ${t.requests} ${dim('(full session file)')}`);
  L.push(`Input (unc.)   ${fmtTokens(t.inputTokens)} tok`);
  L.push(`Cache Read     ${fmtTokens(t.cacheReadTokens)} tok`);
  L.push(`Cache Write    ${fmtTokens(t.cacheWriteTokens)} tok`);
  L.push(`Output         ${fmtTokens(t.outputTokens)} tok`);
  if (ledger.spendUsd) {
    L.push(`Prefill Spend  ${fmtUsd(ledger.spendUsd.prefillUsd)} ${dim(`[${ledger.spendUsd.source}]`)}`);
    if (ledger.spendUsd.outputUsd !== undefined) {
      L.push(`Output Spend   ${fmtUsd(ledger.spendUsd.outputUsd)} ${dim('[snapshot]')}`);
    }
    L.push(`Cache Saving   ${fmtUsd(ledger.savingsVsNoCacheUsd)} ${dim('vs no-cache world')}`);
  } else if (quota) {
    L.push(dim('Pricing       quota mode (cached tokens count fully) — token ledger only'));
  } else {
    L.push(dim('Pricing       PRICING_UNKNOWN — token ledger only, no USD invented'));
  }
  L.push('');
  const bleedLabel = priced ? fmtUsd(ledger.verified.bleedUsd) : `${fmtTokens(ledger.verified.lostContextTokens)} tok`;
  L.push(bold(`Cache Bleed (verified): ${bleedLabel}`) + dim(`  — ${ledger.verified.entries.length} MISS/PARTIAL events`));
  for (const e of ledger.verified.entries.slice(-8)) {
    const when = new Date(e.timestamp).toLocaleString();
    const amt = e.bleedUsd !== undefined ? fmtUsd(e.bleedUsd) : `${fmtTokens(Math.max(0, e.contextTokens - e.cacheReadTokens))} tok`;
    const extra: string[] = [ATTR_LABEL[e.attribution] ?? e.attribution];
    if (e.lowerBound) extra.push('lower bound');
    if (e.inferredWriteSurchargeUsd !== undefined) extra.push(`write +${fmtUsd(e.inferredWriteSurchargeUsd)} (inferred)`);
    L.push(`  ${when}  ${amt.padEnd(10)} ${dim(extra.join(' · '))}`);
  }
  if (ledger.verified.entries.length > 8) {
    L.push(dim(`  … ${ledger.verified.entries.length - 8} earlier entries (see --json)`));
  }
  L.push('');
  const exp = priced
    ? `${fmtUsd(ledger.estimated.coldExposureUsd)} ${dim('[estimated]')}`
    : `${fmtTokens(ledger.estimated.coldExposureTokens)} tok ${dim('[estimated]')}`;
  L.push(`Cold Exposure  ${exp}`);
  L.push(dim(`assumption: ${ledger.estimated.assumption}`));
  return L.join('\n');
}

const DOCTOR_ATTR_LABEL: Record<string, string> = {
  ...ATTR_LABEL,
  'model-switch': 'model switch',
};

function renderDoctor(r: DoctorReport, color: boolean): string {
  const dim = (s2: string) => (color ? `[2m${s2}[0m` : s2);
  const bold = (s2: string) => (color ? `[1m${s2}[0m` : s2);
  const L: string[] = [];
  const priced = r.ledger.pricingStatus.kind === 'priced';
  L.push(bold('CacheGuard doctor') + dim(' — attribution diagnosis (metadata-only)'));
  L.push(`Session        ${r.sessionId}`);
  L.push(`Agent          ${r.agent}`);
  L.push('');
  const bleedTotal = priced
    ? '$' + (r.ledger.verified.bleedUsd ?? 0).toFixed(4)
    : fmtTokens(r.ledger.verified.lostContextTokens) + ' tok';
  L.push(`Verified bleed ${bleedTotal} across ${r.ledger.verified.entries.length} MISS/PARTIAL event(s)`);
  if (Object.keys(r.attributionCounts).length > 0) {
    L.push('');
    L.push(bold('Attribution breakdown'));
    for (const [k, v] of Object.entries(r.attributionCounts).sort((a, b) => b[1] - a[1])) {
      L.push(`  ${String(v).padEnd(4)} ${DOCTOR_ATTR_LABEL[k] ?? k} ${dim('(suspected/inferred)')}`);
    }
  }
  if (r.modelSwitches.length > 0) {
    L.push('');
    L.push(bold('Model switches at miss boundaries'));
    for (const m of r.modelSwitches.slice(0, 6)) {
      L.push(`  ${new Date(m.at).toLocaleString()}  ${m.from} → ${m.to}`);
    }
  }
  if (r.recurringLayers.length > 0) {
    L.push('');
    L.push(bold('Recurring residual layers'));
    for (const layer of r.recurringLayers.slice(0, 5)) {
      L.push(`  ×${layer.occurrences}  ${dim(layer.note)}`);
    }
    if (r.recurringLayers.length > 5) {
      L.push(dim(`  … ${r.recurringLayers.length - 5} more clusters (see --json)`));
    }
  }
  if (r.hourClusters.length > 0) {
    L.push('');
    L.push(bold('When do misses cluster? (local time)'));
    for (const h of r.hourClusters.slice(0, 5)) {
      L.push(`  ${h.hour}  ${h.events} event(s), ${fmtTokens(h.lostTokens)} tok lost`);
    }
  }
  if (r.advice.length > 0) {
    L.push('');
    L.push(bold('Advice (each tied to evidence; all conclusions are inferences)'));
    for (const a of r.advice) {
      L.push(`  • [${a.signal}]`);
      L.push(dim(`    evidence: ${a.evidence}`));
      L.push(`    ${a.text}`);
    }
  } else if (r.ledger.verified.entries.length === 0) {
    L.push('');
    L.push(dim('No verified MISS/PARTIAL events in this session — nothing to diagnose.'));
  }
  L.push('');
  L.push(dim(`privacy: ${r.privacyNote}`));
  return L.join('\n');
}

async function runCostAll(engine: SessionEngine, json: boolean | undefined): Promise<void> {
  const rows: Array<{ agent: string; sessionId: string; bleedUsd?: number | undefined; lostTok: number; requests: number }> = [];
  for (const s of engine.store.listSessions()) {
    const obs = engine.store.observationsFor(s.sessionId, 10_000);
    if (obs.length === 0) continue;
    const ledger = computeCostLedger({ agent: s.agent, observations: obs });
    rows.push({
      agent: s.agent,
      sessionId: s.sessionId,
      bleedUsd: ledger.verified.bleedUsd,
      lostTok: ledger.verified.lostContextTokens,
      requests: ledger.totals.requests,
    });
  }
  rows.sort((a, b) => (b.bleedUsd ?? 0) - (a.bleedUsd ?? 0) || b.lostTok - a.lostTok);
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.log(`Cross-session verified bleed (local DB, snapshot ${new Date().toISOString().slice(0, 10)})`);
  for (const r of rows.slice(0, 20)) {
    const amt = r.bleedUsd !== undefined ? '$' + r.bleedUsd.toFixed(4) : fmtTokens(r.lostTok) + ' tok';
    console.log(`${r.agent.padEnd(12)}${r.sessionId.slice(0, 12).padEnd(14)}${amt.padEnd(14)}${r.requests} requests`);
  }
}

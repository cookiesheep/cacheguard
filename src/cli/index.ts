#!/usr/bin/env node
/**
 * cacheguard — read-only prompt-cache observability for coding agents.
 * Phase 1: observe only. No keepalive, no requests, no writes to agent data.
 */
import { Command } from 'commander';
import { SessionEngine } from '../sessions/engine.js';
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
  .description('Read-only prompt-cache observability for coding agents (Phase 1: Claude Code)')
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
        console.log(renderStatus(status, { color: colorEnabled(program.opts()) }));
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

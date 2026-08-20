#!/usr/bin/env node
/**
 * CLI entry. `statusline` is dispatched BEFORE any heavy import: Claude Code
 * invokes it on every UI event, and node's own boot (~100ms) already dominates
 * the budget — the command must not also pay for commander/sqlite/CLI setup.
 * Everything else lazily loads ./main.js.
 */
if (process.argv[2] === 'statusline') {
  const { runStatuslineFast } = await import('./statusline.js');
  await runStatuslineFast();
} else {
  await import('./main.js');
}

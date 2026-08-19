/** CacheGuard public API (library entry). CLI lives in ./cli/index.js. */
export * from './types/index.js';
export { ClaudeCodeAdapter } from './adapters/claude-code/adapter.js';
export { ObservationParser } from './adapters/claude-code/parser.js';
export * from './adapters/claude-code/paths.js';
export { JsonlTailer, readTailSnapshot } from './collector/tailer.js';
export { estimateCacheState, classifyFact, factsFromObservations } from './cache/estimator.js';
export * from './policy/provider-policy.js';
export { CacheGuardStore, defaultDbPath } from './storage/db.js';
export { SessionEngine } from './sessions/engine.js';

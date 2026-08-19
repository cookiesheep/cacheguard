/**
 * Incremental JSONL tailer.
 *
 * Goals (see docs/claude-code-schema.md §6 and the dev plan):
 *  - never re-read bytes (offset checkpoint per file)
 *  - buffer partial trailing lines until the writer completes them
 *  - detect truncation/rotation (size shrank) and re-read from 0
 *  - low overhead: fs.watch for wakeups, 1s poll as fallback/primary on
 *    filesystems where watch is unreliable
 *
 * Emits complete newline-terminated chunks of text; parsing stays in the
 * parser module. Decoding via StringDecoder so multi-byte UTF-8 sequences
 * split across reads survive.
 */
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export interface TailerOptions {
  /** Start at end-of-file (only future appends) instead of reading existing content. */
  startAtEof?: boolean;
  /** Poll interval in ms (default 1000). */
  pollMs?: number;
  /** Called for each completed chunk of lines. */
  onLines: (text: string) => void;
  /** Called when the file shrank (rotation) — consumers should reset state. */
  onTruncate?: () => void;
}

export class JsonlTailer {
  private offset = 0;
  private pending = Buffer.alloc(0);
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly decoder = new StringDecoder('utf8');

  constructor(
    private readonly filePath: string,
    private readonly opts: TailerOptions,
  ) {}

  /** Open the file, emit existing content (unless startAtEof), begin watching. */
  start(): void {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.filePath);
    } catch (err) {
      throw new Error(`Cannot stat session file ${this.filePath}: ${(err as Error).message}`);
    }
    this.offset = this.opts.startAtEof ? st.size : 0;
    if (!this.opts.startAtEof && st.size > 0) this.readNewBytes();

    try {
      this.watcher = fs.watch(this.filePath, () => {
        if (!this.closed) this.readNewBytes();
      });
      this.watcher.on('error', () => this.stopWatchOnly()); // fall back to polling
    } catch {
      // watch unsupported → polling below is the only channel, still correct
    }
    this.pollTimer = setInterval(() => {
      if (!this.closed) this.readNewBytes();
    }, this.opts.pollMs ?? 1000);
  }

  private stopWatchOnly(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  /** Read everything after `offset`, complete lines only; partial tail is buffered. */
  private readNewBytes(): void {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.filePath);
    } catch {
      return; // transient (rename during rotation); poll will retry
    }
    if (st.size < this.offset) {
      // truncated or replaced with a shorter file → reset
      this.offset = 0;
      this.pending = Buffer.alloc(0);
      this.opts.onTruncate?.();
    }
    if (st.size === this.offset) return;

    const fd = fs.openSync(this.filePath, 'r');
    try {
      const chunk = Buffer.alloc(st.size - this.offset);
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, this.offset);
      const data = chunk.subarray(0, bytesRead);
      const combined = this.pending.length ? Buffer.concat([this.pending, data]) : data;

      let lastNewline = -1;
      for (let i = combined.length - 1; i >= 0; i--) {
        if (combined[i] === 0x0a) {
          lastNewline = i;
          break;
        }
      }

      if (lastNewline >= 0) {
        const complete = combined.subarray(0, lastNewline + 1);
        this.pending = Buffer.from(combined.subarray(lastNewline + 1));
        this.offset += bytesRead - this.pending.length;
        this.opts.onLines(this.decoder.write(complete));
      } else {
        this.pending = combined;
        this.offset += bytesRead;
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  /** One-shot flush: treat buffered partial line as complete (end-of-session). */
  flushPending(): string {
    if (this.pending.length === 0) return '';
    const text = this.decoder.write(this.pending);
    this.pending = Buffer.alloc(0);
    return text.endsWith('\n') ? text : text + '\n';
  }

  stop(): void {
    this.closed = true;
    this.stopWatchOnly();
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }
}

/**
 * Read the last `maxBytes` of a file, aligned forward to the next newline so
 * the first yielded line is complete. Returns { text, skippedBytes } — the
 * quick snapshot path for `cacheguard status` on huge session files.
 */
export function readTailSnapshot(
  filePath: string,
  maxBytes: number,
): { text: string; skippedBytes: number } {
  const st = fs.statSync(filePath);
  if (st.size <= maxBytes) {
    return { text: fs.readFileSync(filePath, 'utf8'), skippedBytes: 0 };
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const start = st.size - maxBytes;
    const chunk = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, chunk, 0, maxBytes, start);
    const data = chunk.subarray(0, bytesRead);
    let firstNewline = data.indexOf(0x0a);
    if (firstNewline === -1) return { text: '', skippedBytes: start + bytesRead };
    firstNewline += 1;
    return {
      text: data.subarray(firstNewline).toString('utf8'),
      skippedBytes: start + firstNewline,
    };
  } finally {
    fs.closeSync(fd);
  }
}

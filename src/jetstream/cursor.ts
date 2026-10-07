import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "pino";

// Remembers the newest time_us we have ingested and persists it to a file so a restart resumes
// near where it stopped. The cursor advances at ingest, not after a route finishes with the
// event, so events still queued at shutdown are only replayed via the rewind margin.
// Delivery is therefore at-least-once; handlers must tolerate duplicates.

export interface CursorStoreOptions {
  file: string;
  rewindMs: number;
  persistEveryMs: number;
  log: Logger;
}

export class CursorStore {
  private lastTimeUs = 0;
  private persistedTimeUs = 0;

  constructor(private readonly opts: CursorStoreOptions) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.opts.file, "utf8");
      const parsed = JSON.parse(raw) as { timeUs?: unknown };
      if (typeof parsed.timeUs === "number" && parsed.timeUs > 0) {
        this.lastTimeUs = this.persistedTimeUs = parsed.timeUs;
        this.opts.log.info({ cursor: this.lastTimeUs, file: this.opts.file }, "cursor loaded");
        return;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.opts.log.warn({ err, file: this.opts.file }, "cursor file unreadable, starting live");
      }
    }
    this.opts.log.info({ file: this.opts.file }, "no cursor, starting live");
  }

  advance(timeUs: number): void {
    if (timeUs > this.lastTimeUs) this.lastTimeUs = timeUs;
  }

  get current(): number {
    return this.lastTimeUs;
  }

  // What to put in ?cursor= on (re)connect. undefined = no cursor, start live.
  resumeFrom(): number | undefined {
    if (this.lastTimeUs === 0) return undefined;
    return Math.max(0, this.lastTimeUs - this.opts.rewindMs * 1000);
  }

  startPersisting(signal: AbortSignal): void {
    const timer = setInterval(() => {
      // Fire-and-forget on purpose: a failed write is logged, not awaited by the ingest path.
      void this.persist();
    }, this.opts.persistEveryMs);
    timer.unref(); // never keep the process alive just for this
    signal.addEventListener("abort", () => clearInterval(timer), { once: true });
  }

  async persist(): Promise<void> {
    if (this.lastTimeUs === this.persistedTimeUs) return;
    const value = this.lastTimeUs;
    try {
      await mkdir(dirname(this.opts.file), { recursive: true });
      // Write to a temp file then rename: a crash mid-write never leaves a torn cursor file.
      const tmp = `${this.opts.file}.tmp`;
      await writeFile(tmp, JSON.stringify({ timeUs: value }));
      await rename(tmp, this.opts.file);
      this.persistedTimeUs = value;
    } catch (err) {
      this.opts.log.warn({ err, file: this.opts.file }, "cursor persist failed");
    }
  }
}

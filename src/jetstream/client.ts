import type { Logger } from "pino";
import type { Metrics } from "../observability/metrics.js";
import type { CursorStore } from "./cursor.js";
import { decodeEnvelope, type JetstreamEvent } from "./event.js";

// Owns the single WebSocket. Reconnects with exponential backoff and resumes from the cursor.
// Uses Node's built-in global WebSocket (Node 22+), which has no read backpressure: it will
// keep calling onmessage as fast as frames arrive. That is why onEvent must be synchronous and
// cheap (it is router.dispatch), and why event-loop lag is the health signal, not socket state.

export interface JetstreamClientOptions {
  url: string;
  wantedCollections: string[];
  cursor: CursorStore;
  onEvent: (event: JetstreamEvent) => void;
  signal: AbortSignal;
  backoffInitialMs: number;
  backoffMaxMs: number;
  log: Logger;
  metrics: Metrics;
}

export class JetstreamClient {
  private _connected = false;
  private _lastEventAtMs = 0;

  constructor(private readonly opts: JetstreamClientOptions) {}

  get connected(): boolean {
    return this._connected;
  }

  get lastEventAtMs(): number {
    return this._lastEventAtMs;
  }

  // Resolves only when the signal is aborted and the socket is closed.
  async run(): Promise<void> {
    const { signal, log, metrics } = this.opts;
    let delayMs = this.opts.backoffInitialMs;
    while (!signal.aborted) {
      const openedAt = Date.now();
      await this.connectOnce();
      if (signal.aborted) break;
      // A session that lasted a while was healthy; do not punish the next reconnect for it.
      if (Date.now() - openedAt > 30_000) delayMs = this.opts.backoffInitialMs;
      metrics.jetstreamReconnects.inc();
      const jitter = Math.floor(Math.random() * delayMs * 0.2);
      log.warn({ delayMs: delayMs + jitter }, "jetstream disconnected, reconnecting");
      await sleep(delayMs + jitter, signal);
      delayMs = Math.min(delayMs * 2, this.opts.backoffMaxMs);
    }
    log.info("jetstream client stopped");
  }

  private buildUrl(): string {
    const url = new URL(this.opts.url);
    const cursor = this.opts.cursor.resumeFrom();
    if (cursor !== undefined) url.searchParams.set("cursor", String(cursor));
    for (const c of this.opts.wantedCollections) url.searchParams.append("wantedCollections", c);
    return url.toString();
  }

  // One socket lifetime. Resolves when the socket closes for any reason.
  private connectOnce(): Promise<void> {
    const { signal, log, metrics, cursor, onEvent } = this.opts;
    return new Promise<void>((resolve) => {
      const url = this.buildUrl();
      log.info({ url: redactQuery(url), cursor: cursor.resumeFrom() }, "jetstream connecting");
      const ws = new WebSocket(url);

      const onAbort = () => ws.close(1000, "shutdown");
      signal.addEventListener("abort", onAbort, { once: true });

      ws.onopen = () => {
        this._connected = true;
        metrics.jetstreamConnected.set(1);
        log.info("jetstream connected");
      };

      ws.onmessage = (msg) => {
        if (typeof msg.data !== "string") {
          metrics.ingestMalformed.inc();
          return;
        }
        const event = decodeEnvelope(msg.data);
        if (!event) {
          metrics.ingestMalformed.inc();
          return;
        }
        this._lastEventAtMs = Date.now();
        cursor.advance(event.timeUs);
        // now - event time: covers network and server delay as well as our own backlog.
        metrics.ingestLagSeconds.set(Math.max(0, this._lastEventAtMs - event.timeUs / 1000) / 1000);
        onEvent(event); // synchronous by design — see router.dispatch
      };

      ws.onerror = () => {
        // The close event that follows carries the useful detail; errors here are terse.
        log.warn("jetstream socket error");
      };

      ws.onclose = (ev) => {
        this._connected = false;
        metrics.jetstreamConnected.set(0);
        signal.removeEventListener("abort", onAbort);
        log.info({ code: ev.code, reason: ev.reason }, "jetstream socket closed");
        resolve();
      };
    });
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

function redactQuery(url: string): string {
  return url.split("?")[0] ?? url;
}

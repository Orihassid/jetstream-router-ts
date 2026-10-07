import { monitorEventLoopDelay } from "node:perf_hooks";
import { Counter, Gauge, Registry, collectDefaultMetrics } from "prom-client";

export interface Metrics {
  registry: Registry;
  received: Counter<"route">;
  processed: Counter<"route">;
  dropped: Counter<"route">;
  failed: Counter<"route">;
  unmatched: Counter;
  queueDepth: Gauge<"route">;
  ingestMalformed: Counter;
  ingestLagSeconds: Gauge;
  jetstreamConnected: Gauge;
  jetstreamReconnects: Counter;
  eventLoopLag: EventLoopLagMonitor;
}

export function createMetrics(): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const eventLoopLag = new EventLoopLagMonitor();

  const m: Metrics = {
    registry,
    received: new Counter({ name: "router_events_received_total", help: "Events matched to this route", labelNames: ["route"], registers: [registry] }),
    processed: new Counter({ name: "router_events_processed_total", help: "Events a handler completed", labelNames: ["route"], registers: [registry] }),
    dropped: new Counter({ name: "router_events_dropped_total", help: "Events dropped because the route queue was full", labelNames: ["route"], registers: [registry] }),
    failed: new Counter({ name: "router_events_failed_total", help: "Events whose handler threw", labelNames: ["route"], registers: [registry] }),
    unmatched: new Counter({ name: "router_events_unmatched_total", help: "Events no route wanted", registers: [registry] }),
    queueDepth: new Gauge({ name: "router_queue_depth", help: "Events waiting in the route queue", labelNames: ["route"], registers: [registry] }),
    ingestMalformed: new Counter({ name: "ingest_malformed_total", help: "Frames that did not decode as Jetstream events", registers: [registry] }),
    ingestLagSeconds: new Gauge({ name: "ingest_lag_seconds", help: "now - time_us of the last ingested event", registers: [registry] }),
    jetstreamConnected: new Gauge({ name: "jetstream_connected", help: "1 when the WebSocket is open", registers: [registry] }),
    jetstreamReconnects: new Counter({ name: "jetstream_reconnects_total", help: "Reconnect attempts after a socket close", registers: [registry] }),
    eventLoopLag,
  };

  new Gauge({
    name: "event_loop_lag_seconds",
    help: "Event-loop delay over the last sample window",
    labelNames: ["quantile"],
    registers: [registry],
    collect() {
      const s = eventLoopLag.last;
      this.set({ quantile: "0.5" }, s.p50Ms / 1000);
      this.set({ quantile: "0.99" }, s.p99Ms / 1000);
      this.set({ quantile: "max" }, s.maxMs / 1000);
    },
  });

  return m;
}

export interface LagSample {
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
}

// Wraps perf_hooks.monitorEventLoopDelay. The histogram accumulates forever, so we sample and
// reset it on an interval: `last` is always "the last few seconds", which is what readiness
// and the metric both want. This is the key health signal for a single-event-loop service:
// a handler that blocks the loop shows up here before anything else fails.
export class EventLoopLagMonitor {
  // The histogram records the observed interval of a timer that fires every `resolution` ms,
  // so a perfectly idle loop reads ~resolution, not 0. We subtract it to report real lag.
  private static readonly RESOLUTION_MS = 20;
  private readonly histogram = monitorEventLoopDelay({ resolution: EventLoopLagMonitor.RESOLUTION_MS });
  private timer: NodeJS.Timeout | undefined;
  last: LagSample = { p50Ms: 0, p99Ms: 0, maxMs: 0 };

  start(sampleEveryMs = 5_000): void {
    this.histogram.enable();
    this.timer = setInterval(() => this.sample(), sampleEveryMs);
    this.timer.unref();
  }

  sample(): LagSample {
    const h = this.histogram;
    const ms = (ns: number) => Math.max(0, ns / 1e6 - EventLoopLagMonitor.RESOLUTION_MS);
    this.last = { p50Ms: ms(h.percentile(50)), p99Ms: ms(h.percentile(99)), maxMs: ms(h.max) };
    h.reset();
    return this.last;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.histogram.disable();
  }
}

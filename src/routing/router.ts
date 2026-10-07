import type { Logger } from "pino";
import type { JetstreamEvent } from "../jetstream/event.js";
import type { Metrics } from "../observability/metrics.js";
import { BoundedQueue } from "./bounded-queue.js";
import { classify } from "./classifier.js";
import type { Route } from "./route.js";
import { runWorkers } from "./worker-pool.js";

export interface RouterDeps {
  log: Logger;
  metrics: Metrics;
}

interface Entry {
  route: Route;
  queue: BoundedQueue<JetstreamEvent>;
}

// Fans events out to routes. dispatch() is the hot path and is deliberately synchronous:
// classify, try to enqueue, count. It never awaits and never throws for a full queue.
export class Router {
  private readonly entries: Entry[];
  private readonly byName = new Map<string, Entry>();
  private running: Promise<void> | undefined;

  constructor(
    private readonly routes: readonly Route[],
    private readonly deps: RouterDeps,
  ) {
    this.entries = routes.map((route) => ({ route, queue: new BoundedQueue<JetstreamEvent>(route.queueSize) }));
    for (const entry of this.entries) {
      if (this.byName.has(entry.route.name)) throw new Error(`duplicate route name: ${entry.route.name}`);
      this.byName.set(entry.route.name, entry);
      // Make every per-route series exist from the start so dashboards show zeros, not gaps.
      for (const c of [deps.metrics.received, deps.metrics.processed, deps.metrics.dropped, deps.metrics.failed]) c.inc({ route: entry.route.name }, 0);
      deps.metrics.queueDepth.set({ route: entry.route.name }, 0);
    }
  }

  dispatch(event: JetstreamEvent): void {
    const { metrics } = this.deps;
    const matched = classify(event, this.routes);
    if (matched.length === 0) {
      metrics.unmatched.inc();
      return;
    }
    for (const route of matched) {
      const entry = this.byName.get(route.name)!; // routes and entries are built from the same list
      const labels = { route: route.name };
      metrics.received.inc(labels);
      if (entry.queue.tryEnqueue(event)) {
        metrics.queueDepth.set(labels, entry.queue.size);
      } else {
        metrics.dropped.inc(labels); // drop-newest: the event is gone, the counter is the alarm
      }
    }
  }

  start(): void {
    if (this.running) return;
    this.running = Promise.all(this.entries.map((e) => runWorkers(e.route, e.queue, this.deps))).then(() => undefined);
    this.deps.log.info({ routes: this.entries.map((e) => ({ name: e.route.name, queueSize: e.route.queueSize, workers: e.route.workers })) }, "router started");
  }

  // Stop accepting, let workers drain what is buffered, but never wait longer than the timeout:
  // a handler that never resolves must not block shutdown.
  async shutdown(drainTimeoutMs: number): Promise<void> {
    const { log } = this.deps;
    for (const e of this.entries) e.queue.close();
    if (!this.running) return;

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), drainTimeoutMs);
    });
    const outcome = await Promise.race([this.running.then(() => "drained" as const), timeout]);
    clearTimeout(timer);

    const leftover = this.entries.filter((e) => e.queue.size > 0).map((e) => ({ route: e.route.name, queued: e.queue.size }));
    if (outcome === "timeout") log.warn({ drainTimeoutMs, leftover }, "drain timed out, abandoning queued events");
    else log.info("router drained");
  }
}

import type { Logger } from "pino";
import type { Metrics } from "../observability/metrics.js";
import type { BoundedQueue } from "./bounded-queue.js";
import type { Route } from "./route.js";
import type { JetstreamEvent } from "../jetstream/event.js";

export interface WorkerDeps {
  log: Logger;
  metrics: Metrics;
}

// N independent async loops over one queue. Each event is wrapped in try/catch so one bad
// event or one broken handler fails that event only, never the loop, never the process.
// Resolves when the queue is closed and every loop has exited.
export function runWorkers(route: Route, queue: BoundedQueue<JetstreamEvent>, deps: WorkerDeps): Promise<void> {
  const { log, metrics } = deps;
  const labels = { route: route.name };

  async function loop(workerId: number): Promise<void> {
    for (;;) {
      const event = await queue.take();
      if (event === undefined) return; // closed and drained
      metrics.queueDepth.set(labels, queue.size);
      try {
        await route.handler(event);
        metrics.processed.inc(labels);
      } catch (err) {
        metrics.failed.inc(labels);
        log.warn(
          { route: route.name, workerId, err, did: event.did, collection: event.commit?.collection, op: event.commit?.operation, rkey: event.commit?.rkey },
          "handler failed",
        );
      }
    }
  }

  const loops = Array.from({ length: route.workers }, (_, i) => loop(i));
  return Promise.all(loops).then(() => undefined);
}

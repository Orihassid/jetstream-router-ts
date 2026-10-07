import type { JetstreamEvent } from "../jetstream/event.js";

// The one seam between the router and the work. A route is data: a name, a predicate, a
// handler, and its own sizing. Handlers are async and must stay light — they share the event
// loop with ingest. Anything CPU-heavy belongs in worker_threads or another pod.

export type Handler = (event: JetstreamEvent) => Promise<void>;

export interface Route {
  name: string; // metric label and log field
  match: (event: JetstreamEvent) => boolean;
  handler: Handler;
  queueSize: number;
  workers: number;
}

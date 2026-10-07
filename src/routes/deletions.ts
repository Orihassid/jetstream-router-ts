import type { Logger } from "pino";
import { Counter, type Registry } from "prom-client";
import type { Config } from "../config.js";
import { atUri } from "../jetstream/event.js";
import type { Route } from "../routing/route.js";

// Retraction path: every delete, from any collection, handled separately from creates.
// The "work" is simulated: a per-collection counter and a debug log line with the record URI.

export interface DeletionsDeps {
  log: Logger;
  config: Config;
  registry: Registry;
}

export function createDeletionsRoute(deps: DeletionsDeps): Route {
  const log = deps.log.child({ route: "deletions" });
  const deletions = new Counter({ name: "deletions_total", help: "Deletes seen, by collection", labelNames: ["collection"], registers: [deps.registry] });
  const settings = deps.config.routeSettings("deletions", { queueSize: 2_000, workers: 4 });

  return {
    name: "deletions",
    ...settings,
    match: (event) => event.kind === "commit" && event.commit?.operation === "delete",
    handler: async (event) => {
      const commit = event.commit!; // match guarantees it
      deletions.inc({ collection: commit.collection });
      log.debug({ did: event.did, collection: commit.collection, rkey: commit.rkey, uri: atUri(event) }, "retraction");
    },
  };
}

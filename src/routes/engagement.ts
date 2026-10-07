import type { Logger } from "pino";
import { Counter, Gauge, type Registry } from "prom-client";
import type { Config } from "../config.js";
import { BurstWindow } from "../lib/burst-window.js";
import type { Route } from "../routing/route.js";

// Engagement aggregation: rolling like+repost counts per subject post; alert when a subject
// crosses the threshold inside the window ("unusual traction"), once per subject per window.
//
// Deletes of likes/reposts also arrive here (decision 12): they are counted as retractions but
// not subtracted from the window, so the count is approximate. The deletions route sees them too.

export interface EngagementDeps {
  log: Logger;
  config: Config;
  registry: Registry;
}

const COLLECTIONS = new Set(["app.bsky.feed.like", "app.bsky.feed.repost"]);

// Like and repost records both carry { subject: { uri, cid } }. We read only the uri.
function subjectUri(record: unknown): string | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  const subject = (record as Record<string, unknown>).subject;
  if (typeof subject !== "object" || subject === null) return undefined;
  const uri = (subject as Record<string, unknown>).uri;
  return typeof uri === "string" ? uri : undefined;
}

export function createEngagementRoute(deps: EngagementDeps): Route {
  const log = deps.log.child({ route: "engagement" });
  const { engagementThreshold: threshold, engagementWindowMs: windowMs, windowMaxKeys: maxKeys } = deps.config;
  const settings = deps.config.routeSettings("engagement", { queueSize: 10_000, workers: 4 });
  const window = new BurstWindow({ threshold, windowMs, maxKeys });

  const alerts = new Counter({ name: "engagement_alerts_total", help: "Subjects that crossed the engagement threshold", registers: [deps.registry] });
  const retractions = new Counter({ name: "engagement_retractions_total", help: "Like/repost deletes seen (not subtracted)", labelNames: ["collection"], registers: [deps.registry] });
  const unreadable = new Counter({ name: "engagement_records_unreadable_total", help: "Like/repost creates without a readable subject", registers: [deps.registry] });
  new Gauge({ name: "engagement_window_keys", help: "Subjects currently tracked in the window", registers: [deps.registry], collect() { this.set(window.keyCount); } });
  new Gauge({ name: "engagement_window_evictions_total", help: "Subjects evicted because the key cap was hit", registers: [deps.registry], collect() { this.set(window.evictionCount); } });

  log.info({ threshold, windowMs, maxKeys }, "engagement route configured");

  return {
    name: "engagement",
    ...settings,
    match: (event) => event.kind === "commit" && COLLECTIONS.has(event.commit?.collection ?? "") && event.commit?.operation !== "update",
    handler: async (event) => {
      const commit = event.commit!; // match guarantees it
      if (commit.operation === "delete") {
        retractions.inc({ collection: commit.collection });
        return;
      }
      const subject = subjectUri(commit.record);
      if (!subject) {
        unreadable.inc();
        return;
      }
      // Event time, not wall time: replayed and backlogged events land in the right window.
      const { count, fired } = window.record(subject, event.timeUs / 1000);
      if (fired) {
        alerts.inc();
        log.info({ subject, count, windowMs, trigger: commit.collection, by: event.did }, "engagement threshold crossed");
      }
    },
  };
}

import type { Logger } from "pino";
import { Counter, Gauge, type Registry } from "prom-client";
import type { Config } from "../config.js";
import { BurstWindow } from "../lib/burst-window.js";
import type { Route } from "../routing/route.js";

// Social-graph tracking: detect a burst of follows to one account inside a window.
// Same detector as engagement, different key: the followed account's DID.

export interface FollowsDeps {
  log: Logger;
  config: Config;
  registry: Registry;
}

// A follow record is { subject: "did:...", createdAt }. We read only the subject.
function followedDid(record: unknown): string | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  const subject = (record as Record<string, unknown>).subject;
  return typeof subject === "string" && subject.startsWith("did:") ? subject : undefined;
}

export function createFollowsRoute(deps: FollowsDeps): Route {
  const log = deps.log.child({ route: "follows" });
  const { followBurstThreshold: threshold, followBurstWindowMs: windowMs, windowMaxKeys: maxKeys } = deps.config;
  const settings = deps.config.routeSettings("follows", { queueSize: 1_000, workers: 2 });
  const window = new BurstWindow({ threshold, windowMs, maxKeys });

  const alerts = new Counter({ name: "follow_burst_alerts_total", help: "Accounts that received a burst of follows", registers: [deps.registry] });
  const unreadable = new Counter({ name: "follow_records_unreadable_total", help: "Follow creates without a readable subject", registers: [deps.registry] });
  new Gauge({ name: "follow_window_keys", help: "Accounts currently tracked in the window", registers: [deps.registry], collect() { this.set(window.keyCount); } });

  log.info({ threshold, windowMs, maxKeys }, "follows route configured");

  return {
    name: "follows",
    ...settings,
    match: (event) => event.kind === "commit" && event.commit?.collection === "app.bsky.graph.follow" && event.commit.operation === "create",
    handler: async (event) => {
      const subject = followedDid(event.commit!.record);
      if (!subject) {
        unreadable.inc();
        return;
      }
      const { count, fired } = window.record(subject, event.timeUs / 1000);
      if (fired) {
        alerts.inc();
        log.info({ subject, count, windowMs, by: event.did }, "follow burst detected");
      }
    },
  };
}

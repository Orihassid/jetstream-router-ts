import type { Logger } from "pino";
import { Counter, type Registry } from "prom-client";
import type { Config } from "../config.js";
import { atUri } from "../jetstream/event.js";
import { RecentSet } from "../lib/recent-set.js";
import type { Route } from "../routing/route.js";

// Content processing: match new posts against configured keywords or languages and emit a
// notification (a structured log line) on a hit.
//
// This is the only route that reads post text, and it is the route most likely to grow CPU
// work (regex, NLP, embeddings). Today the match is a lowercase substring scan: a few
// microseconds for a 300-char post and ~10 keywords. If it ever grows beyond that, the scan
// moves to a worker_threads pool; the route interface does not change.
//
// Privacy rule: `text` is read, lowercased, searched and discarded. It is never stored or logged.

export interface PostsDeps {
  log: Logger;
  config: Config;
  registry: Registry;
}

interface PostRecord {
  text?: string;
  langs?: string[];
}

// Narrow the unknown record to the two fields we read. Anything else is ignored.
function asPostRecord(record: unknown): PostRecord | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  const r = record as Record<string, unknown>;
  const text = typeof r.text === "string" ? r.text : undefined;
  const langs = Array.isArray(r.langs) ? r.langs.filter((l): l is string => typeof l === "string") : undefined;
  return { text, langs };
}

// "en-US" → "en". Jetstream langs are BCP-47 tags of varying specificity.
const primaryTag = (lang: string): string => lang.toLowerCase().split("-")[0] ?? lang;

export function createPostsRoute(deps: PostsDeps): Route {
  const log = deps.log.child({ route: "posts" });
  const keywords = deps.config.postKeywords;
  const langs = new Set(deps.config.postLangs);
  const settings = deps.config.routeSettings("posts", { queueSize: 2_000, workers: 2 });

  const notifications = new Counter({ name: "post_notifications_total", help: "Post notifications emitted", labelNames: ["reason"], registers: [deps.registry] });
  const unreadable = new Counter({ name: "post_records_unreadable_total", help: "Post creates whose record had no readable fields", registers: [deps.registry] });
  const duplicates = new Counter({ name: "post_duplicates_total", help: "Post creates seen twice (cursor rewind)", registers: [deps.registry] });
  const seen = new RecentSet(10_000);

  log.info({ keywords, langs: [...langs] }, "posts route configured");

  return {
    name: "posts",
    ...settings,
    match: (event) => event.kind === "commit" && event.commit?.collection === "app.bsky.feed.post" && event.commit.operation === "create",
    handler: async (event) => {
      const uri = atUri(event)!; // match guarantees a commit
      if (!seen.add(uri)) {
        duplicates.inc();
        return;
      }
      const record = asPostRecord(event.commit!.record);
      if (!record) {
        unreadable.inc();
        return;
      }

      const text = (record.text ?? "").toLowerCase();
      const keyword = keywords.find((k) => text.includes(k));
      const lang = record.langs?.find((l) => langs.has(primaryTag(l)));
      if (keyword === undefined && lang === undefined) return;

      const reason = keyword !== undefined ? "keyword" : "lang";
      notifications.inc({ reason });
      // The notification. Metadata only: who, which post, what matched. Never the text.
      log.info({ did: event.did, uri, reason, keyword, lang, langs: record.langs }, "post matched");
    },
  };
}

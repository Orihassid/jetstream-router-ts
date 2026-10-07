import pino from "pino";
import { Registry } from "prom-client";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../config.js";
import { decodeEnvelope } from "../../jetstream/event.js";
import { createDeletionsRoute } from "../../routes/deletions.js";
import { createEngagementRoute } from "../../routes/engagement.js";
import { createFollowsRoute } from "../../routes/follows.js";
import { createPostsRoute } from "../../routes/posts.js";
import { classify } from "../classifier.js";

// The real routes, the real decoder, realistic Jetstream JSON. Proves the routing table.

const deps = { log: pino({ level: "silent" }), config: loadConfig(), registry: new Registry() };
const routes = [createDeletionsRoute(deps), createPostsRoute(deps), createEngagementRoute(deps), createFollowsRoute(deps)];

const DID = "did:plc:abc123";
const commit = (collection: string, operation: string, record?: unknown) =>
  JSON.stringify({
    did: DID,
    time_us: 1718539200000000,
    kind: "commit",
    commit: { rev: "3lrev", operation, collection, rkey: "3lrkey", cid: operation === "delete" ? undefined : "bafy...", record },
  });

describe("classify", () => {
  const cases: Array<[name: string, raw: string, expected: string[]]> = [
    ["post create", commit("app.bsky.feed.post", "create", { text: "hello", langs: ["en"] }), ["posts"]],
    ["post update", commit("app.bsky.feed.post", "update", { text: "edited" }), []],
    ["post delete", commit("app.bsky.feed.post", "delete"), ["deletions"]],
    ["like create", commit("app.bsky.feed.like", "create", { subject: { uri: "at://x/app.bsky.feed.post/y", cid: "c" } }), ["engagement"]],
    ["like delete fans out to two routes", commit("app.bsky.feed.like", "delete"), ["deletions", "engagement"]],
    ["repost create", commit("app.bsky.feed.repost", "create", { subject: { uri: "at://x/app.bsky.feed.post/y", cid: "c" } }), ["engagement"]],
    ["follow create", commit("app.bsky.graph.follow", "create", { subject: "did:plc:target" }), ["follows"]],
    ["follow delete", commit("app.bsky.graph.follow", "delete"), ["deletions"]],
    ["block create (no route)", commit("app.bsky.graph.block", "create", { subject: "did:plc:target" }), []],
    ["profile update (no route)", commit("app.bsky.actor.profile", "update", { displayName: "x" }), []],
    ["unknown collection create (no route)", commit("app.rocksky.scrobble", "create", { track: "x" }), []],
    ["unknown collection delete (deletions)", commit("app.rocksky.scrobble", "delete"), ["deletions"]],
    ["identity event", JSON.stringify({ did: DID, time_us: 1, kind: "identity", identity: { did: DID, handle: "x.bsky.social", seq: 1, time: "t" } }), []],
    ["account event", JSON.stringify({ did: DID, time_us: 1, kind: "account", account: { active: true, did: DID, seq: 1, time: "t" } }), []],
  ];

  it.each(cases)("%s", (_name, raw, expected) => {
    const event = decodeEnvelope(raw);
    expect(event).toBeDefined();
    expect(classify(event!, routes).map((r) => r.name)).toEqual(expected);
  });
});

describe("decodeEnvelope rejects", () => {
  const bad: Array<[name: string, raw: string]> = [
    ["malformed JSON", "{not json"],
    ["a non-object", "42"],
    ["missing did", JSON.stringify({ time_us: 1, kind: "commit", commit: {} })],
    ["missing time_us", JSON.stringify({ did: DID, kind: "identity" })],
    ["unknown kind", JSON.stringify({ did: DID, time_us: 1, kind: "sync" })],
    ["commit without commit body", JSON.stringify({ did: DID, time_us: 1, kind: "commit" })],
    ["unknown operation", commit("app.bsky.feed.post", "upsert")],
    ["commit missing rkey", JSON.stringify({ did: DID, time_us: 1, kind: "commit", commit: { rev: "r", operation: "create", collection: "c" } })],
  ];
  it.each(bad)("%s", (_name, raw) => {
    expect(decodeEnvelope(raw)).toBeUndefined();
  });

  it("keeps the record untyped and leaves cid undefined on delete", () => {
    const ev = decodeEnvelope(commit("app.bsky.feed.post", "delete"))!;
    expect(ev.commit?.cid).toBeUndefined();
    expect(ev.commit?.record).toBeUndefined();
    const ev2 = decodeEnvelope(commit("app.bsky.feed.post", "create", { text: "t", anything: [1, 2] }))!;
    expect(ev2.commit?.record).toEqual({ text: "t", anything: [1, 2] });
  });
});

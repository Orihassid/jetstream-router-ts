import pino from "pino";
import type { Counter } from "prom-client";
import { describe, expect, it, vi } from "vitest";
import type { JetstreamEvent } from "../../jetstream/event.js";
import { createMetrics } from "../../observability/metrics.js";
import type { Route } from "../route.js";
import { Router } from "../router.js";

// The isolation proof: a route whose handler never resolves must not block other routes, must
// not block ingest, and must show up as a growing drop counter. Real Router, real queues,
// real metrics; only the handlers are fake.

const log = pino({ level: "silent" });

const event = (i: number): JetstreamEvent => ({
  did: `did:plc:${i}`,
  timeUs: 1_000_000 + i,
  kind: "commit",
  commit: { operation: "create", collection: "app.bsky.feed.post", rkey: `r${i}`, rev: "rev" },
});

async function value(counter: Counter<"route">, route: string): Promise<number> {
  const { values } = await counter.get();
  return values.find((v) => v.labels.route === route)?.value ?? 0;
}

describe("Router", () => {
  it("a stuck route does not block other routes or ingest, and its drops grow", async () => {
    const metrics = createMetrics();
    const healthySeen: string[] = [];
    const stuck: Route = { name: "stuck", match: () => true, handler: () => new Promise(() => {}), queueSize: 5, workers: 1 };
    const healthy: Route = { name: "healthy", match: () => true, handler: async (e) => { healthySeen.push(e.did); }, queueSize: 100, workers: 2 };
    const router = new Router([stuck, healthy], { log, metrics });
    router.start();

    for (let i = 0; i < 50; i++) router.dispatch(event(i));

    // (b) dispatch is synchronous: nothing has been processed yet, because no await has happened.
    expect(healthySeen).toHaveLength(0);

    // (a) the healthy route processes everything while the stuck route goes nowhere.
    await vi.waitFor(() => expect(healthySeen).toHaveLength(50));
    expect(await value(metrics.processed, "healthy")).toBe(50);
    expect(await value(metrics.dropped, "healthy")).toBe(0);

    // (c) stuck: worker took 1, queue holds 5, the remaining 44 were dropped and counted.
    expect(await value(metrics.received, "stuck")).toBe(50);
    expect(await value(metrics.dropped, "stuck")).toBe(44);
    expect(await value(metrics.processed, "stuck")).toBe(0);

    // Ingest keeps going: more events, more drops for stuck, all processed for healthy.
    for (let i = 50; i < 100; i++) router.dispatch(event(i));
    await vi.waitFor(() => expect(healthySeen).toHaveLength(100));
    expect(await value(metrics.dropped, "stuck")).toBe(94);

    // Shutdown is bounded even though one handler will never resolve.
    const started = Date.now();
    await router.shutdown(50);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("fans one event out to every matching route and counts unmatched", async () => {
    const metrics = createMetrics();
    const a: Route = { name: "a", match: (e) => e.commit?.collection === "app.bsky.feed.post", handler: async () => {}, queueSize: 10, workers: 1 };
    const b: Route = { name: "b", match: (e) => e.commit?.operation === "create", handler: async () => {}, queueSize: 10, workers: 1 };
    const router = new Router([a, b], { log, metrics });
    router.start();

    router.dispatch(event(1)); // post create: matches both
    router.dispatch({ ...event(2), kind: "identity", commit: undefined }); // matches none

    expect(await value(metrics.received, "a")).toBe(1);
    expect(await value(metrics.received, "b")).toBe(1);
    expect((await metrics.unmatched.get()).values[0]?.value).toBe(1);
    await router.shutdown(100);
  });

  it("a throwing handler fails that event only and the worker keeps going", async () => {
    const metrics = createMetrics();
    let calls = 0;
    const flaky: Route = {
      name: "flaky",
      match: () => true,
      handler: async () => { if (++calls % 2 === 0) throw new Error("boom"); },
      queueSize: 10,
      workers: 1,
    };
    const router = new Router([flaky], { log, metrics });
    router.start();
    for (let i = 0; i < 10; i++) router.dispatch(event(i));
    await vi.waitFor(() => expect(calls).toBe(10));
    expect(await value(metrics.processed, "flaky")).toBe(5);
    expect(await value(metrics.failed, "flaky")).toBe(5);
    await router.shutdown(100);
  });

  it("rejects duplicate route names", () => {
    const r: Route = { name: "dup", match: () => true, handler: async () => {}, queueSize: 1, workers: 1 };
    expect(() => new Router([r, { ...r }], { log, metrics: createMetrics() })).toThrow(/duplicate/);
  });
});

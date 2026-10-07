import { loadConfig } from "./config.js";
import { JetstreamClient } from "./jetstream/client.js";
import { CursorStore } from "./jetstream/cursor.js";
import { startHttpServer } from "./observability/http.js";
import { createLogger } from "./observability/logger.js";
import { createMetrics } from "./observability/metrics.js";
import { createDeletionsRoute } from "./routes/deletions.js";
import { createEngagementRoute } from "./routes/engagement.js";
import { createFollowsRoute } from "./routes/follows.js";
import { createPostsRoute } from "./routes/posts.js";
import { Router } from "./routing/router.js";
import { installProcessHandlers } from "./shutdown.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  const metrics = createMetrics();

  // One AbortController is the shutdown signal for everything that waits.
  const shutdown = new AbortController();
  installProcessHandlers(log, () => shutdown.abort());

  const cursor = new CursorStore({ file: config.cursorFile, rewindMs: config.cursorRewindMs, persistEveryMs: config.cursorPersistMs, log });
  await cursor.load();

  // Routes are registered here. Adding an event type = one factory in this list + one file.
  const routeDeps = { log, config, registry: metrics.registry };
  const routes = [
    createDeletionsRoute(routeDeps),
    createPostsRoute(routeDeps),
    createEngagementRoute(routeDeps),
    createFollowsRoute(routeDeps),
  ];
  const router = new Router(routes, { log, metrics });
  router.start();

  const client = new JetstreamClient({
    url: config.jetstreamUrl,
    wantedCollections: config.wantedCollections,
    cursor,
    onEvent: (event) => router.dispatch(event), // sync: accept-or-drop, never await
    signal: shutdown.signal,
    backoffInitialMs: config.backoffInitialMs,
    backoffMaxMs: config.backoffMaxMs,
    log,
    metrics,
  });

  metrics.eventLoopLag.start();
  const server = startHttpServer({
    port: config.httpPort,
    registry: metrics.registry,
    log,
    isReady: () => {
      const reasons: string[] = [];
      if (!client.connected) reasons.push("not connected");
      if (Date.now() - client.lastEventAtMs > config.readyMaxIdleMs) reasons.push("no events recently");
      if (metrics.eventLoopLag.last.p99Ms > config.readyMaxLagMs) reasons.push(`event loop lag p99 ${metrics.eventLoopLag.last.p99Ms.toFixed(0)}ms`);
      return { ready: reasons.length === 0, reasons };
    },
  });
  cursor.startPersisting(shutdown.signal);

  // Blocks until SIGTERM: run() only returns once the signal is aborted and the socket closed.
  await client.run();

  // Shutdown order: ingest is already stopped → stop accepting into queues and drain workers
  // (bounded) → persist the cursor → stop serving → exit. Anything still queued is logged as lost;
  // the rewind margin on the next start is what covers it (at-least-once).
  log.info("shutting down");
  await router.shutdown(config.shutdownTimeoutMs);
  await cursor.persist();
  metrics.eventLoopLag.stop();
  server.close();
  log.info({ cursor: cursor.current }, "shutdown complete");
  // Explicit exit: a handler stuck forever holds a promise, not a handle, so the loop would
  // actually exit on its own — but we do not want to depend on that reasoning.
  process.exit(0);
}

main().catch((err: unknown) => {
  // Logger may not exist yet if config failed; stderr is the honest fallback.
  console.error(JSON.stringify({ level: "fatal", msg: "startup failed", err: String(err) }));
  process.exit(1);
});

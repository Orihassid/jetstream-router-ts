import { createServer, type Server } from "node:http";
import type { Logger } from "pino";
import type { Registry } from "prom-client";

export interface Readiness {
  ready: boolean;
  reasons: string[];
}

export interface HttpOptions {
  port: number;
  registry: Registry;
  isReady: () => Readiness;
  log: Logger;
}

// Liveness: the process answers. Readiness: connected to Jetstream and consuming (decided by
// the caller). Metrics: Prometheus text format.
export function startHttpServer(opts: HttpOptions): Server {
  const server = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (req.url === "/readyz") {
      const r = opts.isReady();
      res.writeHead(r.ready ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify(r));
      return;
    }
    if (req.url === "/metrics") {
      opts.registry
        .metrics()
        .then((body) => res.writeHead(200, { "content-type": opts.registry.contentType }).end(body))
        .catch((err: unknown) => {
          opts.log.warn({ err }, "metrics render failed");
          res.writeHead(500).end();
        });
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(opts.port, () => opts.log.info({ port: opts.port }, "http listening"));
  return server;
}

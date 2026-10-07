import type { Logger } from "pino";

// SIGTERM/SIGINT start the graceful path (main.ts owns the ordering). Anything that escapes a
// handler's try/catch or is a bug in our own code is fatal: log it and exit non-zero so k8s
// restarts a clean process rather than letting a half-broken one keep consuming.
export function installProcessHandlers(log: Logger, onShutdownSignal: (signal: string) => void): void {
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      log.info({ signal: sig }, "shutdown signal received");
      onShutdownSignal(sig);
    });
  }
  process.on("unhandledRejection", (reason) => {
    log.fatal({ err: reason }, "unhandled rejection, exiting");
    process.exit(1);
  });
  process.on("uncaughtException", (err) => {
    log.fatal({ err }, "uncaught exception, exiting");
    process.exit(1);
  });
}

import pino from "pino";

// JSON logs with structured fields. The default pino destination writes synchronously to
// stdout, so the last lines before process.exit() are not lost.
// Rule: never log record bodies or post text. Metadata only (did, collection, rkey, uri).
export function createLogger(level: string): pino.Logger {
  return pino({ level, base: { service: "jetstream-router" } });
}

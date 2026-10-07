// All tunables come from the environment (a ConfigMap in k8s). Every key has a default so
// `npm run dev` works with no setup.

export interface RouteSettings {
  queueSize: number;
  workers: number;
}

export interface Config {
  jetstreamUrl: string;
  wantedCollections: string[]; // empty = subscribe to everything
  cursorFile: string;
  cursorRewindMs: number; // how far behind the last seen time_us we resume
  cursorPersistMs: number;
  backoffInitialMs: number;
  backoffMaxMs: number;
  httpPort: number;
  logLevel: string;
  shutdownTimeoutMs: number; // max time to drain queues on SIGTERM
  readyMaxLagMs: number; // event-loop lag p99 above this = not ready
  readyMaxIdleMs: number; // no event for this long = not ready
  postKeywords: string[]; // lowercase substrings; empty = no keyword matching
  postLangs: string[]; // BCP-47 primary tags, e.g. "he"; empty = no language matching
  engagementThreshold: number; // likes+reposts per subject inside the window that trigger an alert
  engagementWindowMs: number;
  followBurstThreshold: number; // follows to one account inside the window that trigger an alert
  followBurstWindowMs: number;
  windowMaxKeys: number; // hard cap on tracked keys per stateful route
  routeSettings: (name: string, defaults: RouteSettings) => RouteSettings;
}

const env = (key: string, fallback: string): string => process.env[key] ?? fallback;

const envList = (key: string, fallback: string): string[] =>
  env(key, fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`config: ${key} must be a non-negative integer, got "${raw}"`);
  return n;
}

export function loadConfig(): Config {
  return {
    jetstreamUrl: env("JETSTREAM_URL", "wss://jetstream2.us-east.bsky.network/subscribe"),
    wantedCollections: envList("WANTED_COLLECTIONS", ""),
    cursorFile: env("CURSOR_FILE", "./data/cursor.json"),
    cursorRewindMs: envInt("CURSOR_REWIND_MS", 5_000),
    cursorPersistMs: envInt("CURSOR_PERSIST_MS", 5_000),
    backoffInitialMs: envInt("BACKOFF_INITIAL_MS", 500),
    backoffMaxMs: envInt("BACKOFF_MAX_MS", 30_000),
    httpPort: envInt("HTTP_PORT", 8080),
    logLevel: env("LOG_LEVEL", "info"),
    shutdownTimeoutMs: envInt("SHUTDOWN_TIMEOUT_MS", 10_000),
    readyMaxLagMs: envInt("READY_MAX_LAG_MS", 500),
    readyMaxIdleMs: envInt("READY_MAX_IDLE_MS", 30_000),
    postKeywords: envList("POST_KEYWORDS", "bluesky,kubernetes,typescript").map((k) => k.toLowerCase()),
    postLangs: envList("POST_LANGS", "he").map((l) => l.toLowerCase()),
    engagementThreshold: envInt("ENGAGEMENT_THRESHOLD", 25),
    engagementWindowMs: envInt("ENGAGEMENT_WINDOW_MS", 60_000),
    followBurstThreshold: envInt("FOLLOW_BURST_THRESHOLD", 3),
    followBurstWindowMs: envInt("FOLLOW_BURST_WINDOW_MS", 120_000),
    windowMaxKeys: envInt("WINDOW_MAX_KEYS", 50_000),
    // Per-route sizing: ROUTE_DELETIONS_QUEUE_SIZE, ROUTE_DELETIONS_WORKERS, ...
    routeSettings: (name, defaults) => {
      const prefix = `ROUTE_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_`;
      return {
        queueSize: envInt(`${prefix}QUEUE_SIZE`, defaults.queueSize),
        workers: envInt(`${prefix}WORKERS`, defaults.workers),
      };
    },
  };
}

# CLAUDE.md — Jetstream Event Router (Zenity take-home, TypeScript)

## Context
This repo is a take-home for a Senior Software Engineer role at Zenity. The brief is the take-home PDF Zenity sent (not included in this repository).
Goal: a service that consumes the Bluesky Jetstream firehose (one WebSocket, many event types),
classifies each event, and fans it out to independent, type-specific workers. Runs on a local
Kubernetes cluster (kind). Expected effort is ~2–3 hours; the follow-up interview is a 45–60 min
design discussion where I (Ori) must defend and change the design live.

The brief names Go as the target stack; the recruiter allowed other languages if justified.
I chose **TypeScript on Node.js** because it is my strongest language and the workload is I/O-bound.
The design must make that choice defensible — especially the single event loop.

The graders read DESIGN.md most closely and care about reasoning and tradeoffs, not feature count.
They will also read AI.md, which documents this file and the prompts I used.

## How we work together
- **I am the architect. You are a senior pair.** For every non-trivial decision, present 2–3 options
  with concrete tradeoffs and your recommendation, then wait for my choice. Do not silently pick.
- **Plan before code.** Each phase starts with a short plan I approve. Keep diffs small and reviewable.
- **I must be able to explain every line.** Prefer obvious code over clever code. When something is
  subtle (event-loop blocking, promise lifecycle, shutdown ordering, unhandled rejections), add a short
  comment saying why and point it out to me.
- **Idiomatic Node, not ported Go.** No emulated channels or goroutine-style abstractions. Use the
  natural Node tools: async functions, a small bounded-queue class, AbortController, EventEmitter only
  where it truly fits.
- **Log decisions.** After I make a decision, append it to `docs/decisions.md`:
  `## <decision>` / Options / Chosen / Why / What would change my mind.
- **Log prompts.** When I give you a prompt that drives a key decision, append it verbatim (with a
  one-line note on the outcome) to `docs/prompts-log.md`. This feeds AI.md.

## Scope discipline (important)
- Implement 3–4 routes end to end; describe the rest in DESIGN.md. Warn me if we are drifting past the
  2–3 hour budget or adding things the brief marked out of scope (UI, auth, users).
- No speculative abstractions. One interface per real seam (e.g. `Handler`, `Sink`), not five.

## Engineering rules
- Node 22+ (prefer current LTS), TypeScript `strict: true`, ESM. Use Node's built-in global `WebSocket`.
- Allowed deps: `pino` (logging), `prom-client` (metrics), `zod` (only if validation earns its place).
  Dev: `typescript`, `tsx`, `vitest`, `@types/node`. Anything else: ask me first.
- Logging: JSON via pino, structured fields (`route`, `collection`, `op`, `did`).
- **Never log raw post text or record bodies.** This is an unfiltered public firehose. Log metadata
  only (DID, collection, rkey/URI, matched keyword, language). Mention this in DESIGN.md.
- **The event loop is shared by everything.** Handlers must stay light and async. Never do CPU-heavy
  work inline; if something is CPU-heavy, raise it with me (options: `worker_threads`, separate pod).
- **The router never awaits a route.** Enqueue is synchronous: accept or drop-and-count.
- Every route has its own bounded queue and its own pool of async workers. Each worker wraps each event
  in try/catch so one bad event or one failing route never kills the process. Register
  `unhandledRejection` / `uncaughtException` handlers that log and exit cleanly (let k8s restart us).
- Graceful shutdown on SIGTERM via AbortController: stop ingest → stop accepting into queues →
  drain workers (bounded timeout) → persist cursor → exit.
- Metrics per route: received, processed, dropped, failed, queue depth. Plus **event-loop lag**
  (`perf_hooks.monitorEventLoopDelay`) — the key health signal for a Node service like this.
- Time-dependent logic (rolling windows, bursts) takes an injectable clock so it is testable.
- Config (keywords, thresholds, windows, queue sizes, worker counts) comes from env / a ConfigMap.

## Testing
- Vitest. Table-driven classifier/router tests with realistic Jetstream JSON.
- A test proving a stuck route (handler that never resolves) does not block other routes or ingest,
  and that its drop counter grows.
- Window/threshold tests with the fake clock (or `vi.useFakeTimers()`), including boundaries.
- Always run `npm run typecheck` and `npm test` before telling me a phase is done.

## Kubernetes
- Multi-stage Dockerfile: build with `tsc`, run compiled JS on a slim Node image as a non-root user.
  Run `node` directly (not `npm start`) so SIGTERM reaches the process.
- Target: `kind`. Use `kind load docker-image`, not a registry.
- Manifests: Deployment(s), ConfigMap, Service for health/metrics. Liveness and readiness probes that
  mean something (readiness = connected to Jetstream and consuming).
- The README must contain copy-pasteable commands that work from a clean machine with
  docker + kind + kubectl + node installed. Verify them by actually running them.

## Deliverables checklist
- [ ] TypeScript service with several routes wired through the router
- [ ] Dockerfile + k8s manifests, deployed to kind
- [ ] README.md: exact build/deploy steps, how to see it working, assumptions
- [ ] DESIGN.md (1–3 pages) incl. a short "Why TypeScript, not Go" section — **I write the final
      version in my own words**; you may draft and critique
- [ ] AI.md: tools/models, this CLAUDE.md, key prompts, where the agent helped and where I overrode it

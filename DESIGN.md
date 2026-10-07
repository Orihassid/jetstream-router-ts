# DESIGN — Jetstream Event Router

Sections 1 to 4 are the design. Sections 5 to 9 are the evidence, the risks and the corrections.

## 1. The problem

One WebSocket carries a mixed, high-volume event stream. Each event must be classified and
dispatched to type-specific work, and those paths must run, fail and scale independently.

I measured the stream for 36 hours before designing (`scripts/baseline.ts`, 180,000 events). Three
properties of the source drive the design.

**One connection, one reader.** Ingest cannot be parallelised. Anything the reader does inline is
charged to every event type. In Node the whole process is one thread, which makes this sharper.

**A very uneven mix.**

| Route | Share | Events/s (avg) | Queue size | Full after, if its workers stall |
|---|---|---|---|---|
| engagement (likes, reposts) | 74% | 251 | 10,000 | 40 s |
| posts | 12% | 42 | 2,000 | 48 s |
| follows | 6% | 20 | 1,000 | 50 s |
| deletions | 3% | 11 | 2,000 | 3 min |
| no route | 4% | 14 | none | counted and dropped |

**Why these queue sizes**

Sizes were checked against measured traffic. Each queue buffers about 45 seconds of its route's
average rate, about half that at peak.

> queue size ≈ arrival rate × seconds a route may stall

- **Engagement:** 251/s × 40 s ≈ 10,000
- **Posts:** 42/s × 48 s ≈ 2,000
- **Follows:** 20/s × 50 s ≈ 1,000
- **Deletions:** 2,000 is oversized. A round default, not tuned.

Long enough to absorb a short stall, short enough that an alert is still fresh, at most 10 MB.

A 23× spread between the busiest and the quietest route: any resource they share is taken over by
likes. Overall rate: 220 to 555 events/s.

**Duplicates are guaranteed.** Resume is by timestamp cursor, so events repeat after a reconnect.
Delivery is at-least-once and every handler must tolerate it.

So the question this design has to answer is: **how does one slow or failing route avoid affecting
the others?**

## 2. Options I considered

**A. Handle each event inside the socket callback.** Rejected: one slow handler blocks the reader,
and with it every other type. This is head-of-line blocking.

**B. One shared queue feeding one worker pool.** Rejected: the reader is no longer blocked, but the
routes still share a buffer. Likes are 74% of traffic, so a slow like handler fills it and every
other type is dropped with them.

**✅ C. A bounded queue and a worker pool per route. Chosen.** Classify, enqueue to the route's own
queue, drain with its own workers. A stalled route backs up only its own queue.

**D. A message broker with one deployment per route.** Right for production. Over-built for a
200 KB/s stream and a three-hour budget. The router-to-route handoff is a single interface, so
moving to a broker later is a swap, not a rewrite.

**E. Sharding by key.** Solves a different problem: scaling one type across processes. Here a route's
workers share one process and one state map, so there is nothing to partition, and it does not
isolate one type from another. Needed once a stateful route runs on more than one pod, so every
event for a key reaches the same worker. Cost: a broker, and hot keys.

**Why I chose C.** A and B let one slow type starve the rest. D adds durability this stream does not
need yet. C is the simplest option that contains a failure to its own route. Tested: a 50 ms delay in
the engagement handler dropped events there and nowhere else.

**The price of C.** Capacity is not pooled: idle workers on a quiet route cannot help a busy one.
More settings per route. I accept lower utilisation for predictable behaviour under load.

**Where it stops working.** Isolation holds between routes, not between processes. One event loop,
one heap. A CPU-bound handler stalls every route, and a crash takes all of them. Measured in section 5.

## 3. The design

```
Jetstream ──▶ reader ──▶ router ──┬──▶ [queue] ──▶ workers ──▶ posts       keyword or language → notify
              cursor      sorts,   ├──▶ [queue] ──▶ workers ──▶ engagement  25 in 60 s → alert
                          never    ├──▶ [queue] ──▶ workers ──▶ follows     3 in 120 s → alert
                          waits    ├──▶ [queue] ──▶ workers ──▶ deletions   count per type
                                   └──▶ no route: counted
```

| Part | Job |
|---|---|
| Reader | Owns the socket, reconnect with backoff, and the cursor. Checks only the metadata of each event. |
| Router | Synchronous dispatch: classify, `tryEnqueue` on each matching route, count accept or drop. |
| Route | A bounded queue, a worker pool, its own metrics |
| Handler | The per-type work. Knows nothing about the other routes. |

| Route | Matches | Work |
|---|---|---|
| posts | post create | Keyword and language match. Notify on a hit. |
| engagement | like and repost | Sliding count per post. Alert at 25 within 60 s. |
| follows | follow create | Sliding count per followed account. Alert at 3 within 120 s. |
| deletions | any delete, any collection | Count per collection |

One event can match two routes: a like delete reaches deletions and engagement.

## 4. Key decisions

**D1. Dispatch is synchronous. A full queue drops the event.** Node's WebSocket has no read
backpressure, so awaiting only moves the backlog into unbounded pending promises. A bounded queue
with a drop counter caps memory and names the failing route.

**D2. Consume the whole stream. Server-side filter off.** Tested live: `wantedCollections` works and
saves 4%, but it narrows "any delete" to the listed collections and blinds the unmatched counter. It
stays a setting. Its real use is partitioning ingest across pods.

**D3. The cursor advances at ingest, and reconnect rewinds 5 seconds.** At-least-once: duplicates
over gaps. Cost: an event dropped, or still queued at a crash, is not replayed.

**D4. Sliding window as the last N timestamps per key, on event time.** N is the threshold, so
memory per key is fixed and the count is exact. Event time keeps replayed events in the correct
window. Key space capped at 50,000 with least-recently-used eviction. In memory, lost on restart.

**D5. Single replica.** One stream, one consumer. Two would double every alert.

**D6. Failure is contained per event.** Each handler call is wrapped: count, log metadata, continue.
Anything that escapes is a bug: exit non-zero and let Kubernetes restart the process.

**D7. A route is data.** Name, match, handler, queue size, workers. A new type is one file and one
line. Thresholds and keywords come from a ConfigMap.

**D8. Idempotency: required by at-least-once, only partly implemented.** Posts are idempotent: a
bounded set of recent post URIs drops repeats, although it is lost on restart. The counters are not:
a replayed like is counted twice, so counts run high for a few seconds after a reconnect. Alerts are
limited to one per key per window, so a duplicate can fire an alert early but never twice. The fix
is to dedupe by event identity (`did` + collection + `rkey`) in each route.

## 5. What I tested

| Question | Method | Result |
|---|---|---|
| Throughput headroom | Replayed a 20 minute backlog | 5,000 events/s, nine times the busiest hour, under 20% of one core, 0 dropped |
| Route isolation | 50 ms delay in the engagement handler | Its queue filled in 20 s, then dropped about 100/s. The other routes lost nothing. |
| CPU-bound handler | 5 ms busy loop per like | Event-loop lag went from 2 ms to seconds. The queue stayed empty: a queue does not protect against this. |
| Slow consumer | Froze the process for 1 and 5 minutes | Jetstream disconnected it. It resumed from the cursor and caught up in under 20 s. |
| Cursor lookback | Cursors from 15 minutes to 7 days old | 36 hours. Older cursors are silently moved forward. |
| Stability | 23 hours on kind | 30 million events, 56 reconnects all resumed, 0 dropped, 0 failed |

## 6. Security considerations

Every field in every event is attacker-controlled.

- **Post text never reaches a log.** Logs carry IDs and addresses only.
- **Bad input is counted, not trusted.** The reader validates the metadata and skips anything malformed.
- **Dropping is a way to hide.** A dropped event is a missed alert, and it is gone for good. Anyone
  who can generate load on one route can fill its queue on purpose. Today a drop raises a counter. It
  should raise an alarm.
- **Memory is bounded everywhere it grows.** Queues are fixed. Counters are capped at 50,000 keys,
  measured at 40 MB.
- **Alerts cannot be flooded.** One alert per key per window, even if the threshold is crossed on purpose.
- **A known hole.** The deletions metric is labelled by collection name, and anyone can invent
  collection names. It needs a fixed list plus "other".
- **Small footprint.** Non-root container, no credentials, nothing stored except the cursor.

## 7. From prototype to production

| Concern | Prototype | Production |
|---|---|---|
| Handoff to routes | In-memory queues | A broker such as Kafka, NATS or SQS, with a topic per route |
| Counting state | In-memory maps, lost on restart | Atomic counters in Redis or DynamoDB |
| Cursor | File inside the pod | An external store, advanced only after the broker has accepted the event |
| Duplicates | Posts dedupe. Counters accept a brief over-count. | With a broker such as Kafka: the cursor is committed after the broker accepts an event, so the 5 second rewind goes away. An idempotent producer stops retry duplicates. Consumers dedupe by event identity, and each alert carries a stable ID. |
| Scaling | One replica | One reader, many workers. Or partition ingest by type with the server-side filter. |
| CPU-bound work | Not handled | Worker threads, then separate pods |
| Monitoring | Counters and logs | Alarms on drop rate, lag, and time behind the stream |

## 8. Scope and tests

Built to the edge of the time budget. Described, not built: the broker, shared state, more than one
replica, exactly-once delivery, subtracting unlikes.

| Test | What it proves |
|---|---|
| Routing table | Each type reaches the right route, a like delete reaches two, unknown types reach none |
| Stuck handler | A route that never finishes does not block the others, its drops grow, shutdown still ends |
| Failing handler | One bad event fails alone. The worker continues. |
| Queue | FIFO, refuses when full, drains what it accepted on close |
| Sliding window | Fires exactly at the threshold, forgets old entries, alerts once per window |

Not covered by tests: reconnect logic, the cursor store, and the handlers. Those were verified
against the live stream.

## 9. What I got wrong

- **My first measurement was one minute long.** It showed deletes at 10% because it caught a burst
  of unfollows. Thirty-six hours shows 3%.
- **I estimated 20 MB for a full counter map.** Measured, it is 40 MB.
- **The worker counts are starting values, not calculated.** With instant handlers they make no difference yet.
- **I wrote that a too-old cursor would be counted as a gap.** I never built that. Today it is silent.
- **The pod can report ready while minutes behind the stream.** Found only by watching a catch-up.
- **A silently dead connection is never restarted.** It needs a no-events watchdog.

Most of these showed up only when I measured or ran the service, not when I read the code.

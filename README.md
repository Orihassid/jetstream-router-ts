# Jetstream Event Router

One WebSocket to the Bluesky Jetstream firehose, many event types in, each one classified and fanned
out to an independent route with its own bounded queue and worker pool. TypeScript on Node 24, runs
on a local kind cluster.

Design and tradeoffs: [DESIGN.md](DESIGN.md).
AI tooling and prompts: [AI.md](AI.md).

## Prerequisites

- Node 22+ and npm
- Docker (running)
- kind and kubectl

Everything below was run from scratch on macOS. Commands are copy-pasteable from the repo root.

## Run locally (no Kubernetes)

```sh
npm ci
npm run typecheck
npm test
npm run dev
```

Within a few seconds you will see JSON log lines for post notifications, engagement alerts and
follow bursts. In another terminal:

```sh
curl -s localhost:8080/readyz
curl -s localhost:8080/metrics | grep -E '^(router_|ingest_|jetstream_|event_loop_lag)'
```

Stop with Ctrl-C. The service drains its queues, writes `data/cursor.json`, and exits. Start it
again and the first log line is `cursor loaded`: it resumes from where it stopped, minus a 5-second
rewind.

## Deploy to kind

```sh
# 1. Cluster
kind create cluster --name zenity

# 2. Build the image and load it into the cluster (no registry)
docker build -t jetstream-router:dev .
kind load docker-image jetstream-router:dev --name zenity

# 3. Deploy: ConfigMap, Deployment, Service
kubectl apply -f k8s/
kubectl rollout status deploy/jetstream-router --timeout=120s
```

The pod becomes Ready once it is connected to Jetstream and has seen an event (readiness is
`/readyz`, not just "the process is up").

## See it working

Watch the notifications and alerts only:

```sh
kubectl logs -f deploy/jetstream-router | grep -E '"route":"(posts|engagement|follows)"'
```

You will see three kinds of lines. None of them contain post text, only identifiers:

- `post matched` with the post URI and the matched `keyword` or `lang`
- `engagement threshold crossed` with the subject post URI and the count inside the window
- `follow burst detected` with the followed account's DID

Metrics and readiness through the Service:

```sh
kubectl port-forward svc/jetstream-router 8080:8080 &
curl -s localhost:8080/readyz
curl -s localhost:8080/metrics | grep -E '^(router_events|router_queue|jetstream_|ingest_lag|event_loop_lag|post_|engagement_|follow_)'
kill %1
```

The per-route counters are the heart of it: `router_events_received_total`,
`..._processed_total`, `..._dropped_total`, `..._failed_total`, and `router_queue_depth`, all
labelled by `route`. `event_loop_lag_seconds` is the health signal for a single-event-loop service.

### Prove graceful shutdown and cursor resume

Send SIGTERM to the process inside the running container. Kubernetes restarts the container in the
same pod, so the `emptyDir` volume holding the cursor survives:

```sh
kubectl exec deploy/jetstream-router -- sh -c 'kill -TERM 1'
sleep 8
kubectl logs deploy/jetstream-router --previous | grep -E 'signal|drained|shutdown complete'
kubectl logs deploy/jetstream-router | grep -E 'cursor loaded|connecting'
```

The previous container shows the drain and the persisted cursor; the new one shows `cursor loaded`
and connects with `?cursor=` set 5 seconds before the last event it saw.

Deleting the pod instead (`kubectl delete pod -l app=jetstream-router`) replaces the `emptyDir`,
and the new pod starts live. That is deliberate for the prototype; see "Production" below.

### Prove route isolation

The test suite has the proof: a route whose handler never resolves does not block other routes or
ingest, and its drop counter grows. Run `npm test` and look at `src/routing/tests/router.test.ts`.

## Change the configuration

Every tunable is in `k8s/configmap.yaml` (keywords, languages, thresholds, windows, queue sizes,
worker counts, cursor rewind, log level). Edit, then:

```sh
kubectl apply -f k8s/configmap.yaml
kubectl rollout restart deploy/jetstream-router
```

For example, to alert on fewer likes and on Spanish-language posts: set `ENGAGEMENT_THRESHOLD: "10"`
and `POST_LANGS: "es"`.

## Rebuild after a code change

```sh
docker build -t jetstream-router:dev .
kind load docker-image jetstream-router:dev --name zenity
kubectl rollout restart deploy/jetstream-router
```

## Tear down

```sh
kubectl delete -f k8s/
kind delete cluster --name zenity
```

## Assumptions
- **Downstream work is simulated** by structured log lines and Prometheus counters. The shape
  (classify, bounded queue per route, independent workers) is the deliverable, not the sinks.
- **At-least-once.** After a reconnect or restart the service rewinds the cursor by 5 seconds, so
  handlers see duplicates. Post notifications dedupe on URI; the rolling counts accept small
  inflation and say so.
- **One replica.** A single WebSocket means a single consumer. The Deployment uses `Recreate` so two
  pods never consume at once. HA and horizontal scale are described, not built.
- **No content is logged.** This is an unfiltered public firehose. Logs carry DIDs, collections,
  record keys and URIs only.
- **Four routes end to end** (posts, engagement, follows, deletions). Everything else is counted as
  unmatched. Adding a route is one file plus one line in `src/main.ts`.
- Jetstream's `jetstream2.us-east` host (the one in the brief) is a v1 instance using the `time_us`
  cursor. The v2 hosts accept the same cursor on the same path, so the URL is just config.

## Production: how the topology would differ

What runs here is one process with in-process queues. It is the right shape for a prototype and the
wrong one for a service you page people for. The changes, in the order I would make them:

1. **A broker between ingest and routes.** Replace each route's in-process queue with a topic
   (NATS JetStream, Redis Streams or Kafka) and run each route as its own Deployment with its own
   HPA. The ingest pod becomes a thin publisher. This is what makes "fail and scale independently"
   true across pods rather than inside one, and turns "drop when full" into "spill to a durable
   buffer" for routes that must not lose events. The router's `Sink` seam is where the publisher goes.
2. **Cursor in an external store** (Redis or a small table), not an `emptyDir`, so a rescheduled pod
   resumes too.
3. **Ingest HA.** Either active/passive with a Kubernetes Lease (two pods, one consumes, the other
   takes over using the shared cursor), or partition ingest by collection using Jetstream's
   server-side `wantedCollections` filter so several pods each own a subset. Partitioning by
   collection also keeps every like for a given post on one pod, which the rolling windows need.
4. **Stateful routes partitioned by key.** With more than one replica of the engagement route, the
   broker must partition by subject URI so one subject's window lives on one consumer.
5. **CPU-heavy handlers out of the event loop.** The posts route is the one most likely to grow
   real work (regex, language detection, embeddings). First step is a `worker_threads` pool inside
   the pod; at scale, its own Deployment behind the broker.
6. **Real sinks and SLOs.** Webhooks or a notification service instead of log lines; alerts on
   ingest lag, drop rate per route and event-loop lag p99.

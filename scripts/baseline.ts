// Baseline of the Jetstream firehose over the last N hours (default 36, the server's retention).
// Not part of the service. Run: npx tsx scripts/baseline.ts [hours] [eventsPerSample]
//
// How it works: Jetstream replays history from any timestamp ("cursor") inside its retention.
// For each hour going back, we connect with a cursor at that hour, read a few thousand events,
// and divide the count by the span of their own timestamps. That gives the true rate at that
// moment in the past, even though the replay itself arrives much faster than real time.
// Only counts and timestamps are read. Record contents are never touched or printed.

const URL = "wss://jetstream2.us-east.bsky.network/subscribe";
const hoursBack = Number(process.argv[2] ?? "36");
const perSample = Number(process.argv[3] ?? "5000");

interface Sample {
  at: Date; n: number; spanSec: number; rate: number; peakSecond: number; avgBytes: number;
  likes: number; posts: number; reposts: number; follows: number; deletes: number; other: number;
}

function sample(hoursAgo: number): Promise<Sample | undefined> {
  return new Promise((resolve) => {
    const cursor = Math.round((Date.now() - hoursAgo * 3_600_000) * 1000);
    const ws = new WebSocket(`${URL}?cursor=${cursor}`);
    let n = 0, first = 0, last = 0, bytes = 0, likes = 0, posts = 0, reposts = 0, follows = 0, deletes = 0, other = 0;
    const perSecond = new Map<number, number>();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { ws.close(); } catch { /* already closed */ }
      const spanSec = (last - first) / 1e6;
      if (n < 100 || spanSec <= 0) return resolve(undefined);
      // Ignore the first and last (partial) seconds when looking for the busiest second.
      const full = [...perSecond.entries()].sort((a, b) => a[0] - b[0]).slice(1, -1).map(([, c]) => c);
      resolve({ at: new Date(first / 1000), n, spanSec, rate: n / spanSec, peakSecond: full.length ? Math.max(...full) : 0, avgBytes: bytes / n, likes, posts, reposts, follows, deletes, other });
    };
    ws.onmessage = (msg) => {
      const data = String(msg.data);
      const ev = JSON.parse(data) as { time_us: number; kind: string; commit?: { collection: string; operation: string } };
      if (!first) first = ev.time_us;
      last = ev.time_us;
      bytes += Buffer.byteLength(data);
      const sec = Math.floor(ev.time_us / 1e6);
      perSecond.set(sec, (perSecond.get(sec) ?? 0) + 1);
      const c = ev.commit;
      if (!c) other++;
      else if (c.operation === "delete") deletes++;
      else if (c.collection === "app.bsky.feed.like") likes++;
      else if (c.collection === "app.bsky.feed.post") posts++;
      else if (c.collection === "app.bsky.feed.repost") reposts++;
      else if (c.collection === "app.bsky.graph.follow") follows++;
      else other++;
      if (++n >= perSample) finish();
    };
    ws.onerror = finish;
    ws.onclose = finish;
    setTimeout(finish, 15_000);
  });
}

const pct = (a: number, n: number) => ((100 * a) / n).toFixed(0).padStart(3) + "%";
const fmt = (d: Date) => d.toISOString().slice(5, 16).replace("T", " ");
const local = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

console.log(`Jetstream baseline, run ${new Date().toISOString()}  (${hoursBack} hourly samples of ${perSample} events)\n`);
console.log("UTC time     local  ev/sec  busiest-sec  avgBytes  likes posts reposts follows deletes other");
const samples: Sample[] = [];
for (let h = hoursBack - 0.05; h > 0; h -= 1) {
  const s = await sample(h);
  if (!s) { console.log(`(no data ${h.toFixed(0)}h ago)`); continue; }
  samples.push(s);
  console.log(`${fmt(s.at)}  ${local(s.at)}  ${s.rate.toFixed(0).padStart(6)}  ${String(s.peakSecond).padStart(11)}  ${s.avgBytes.toFixed(0).padStart(8)}  ${pct(s.likes, s.n)}  ${pct(s.posts, s.n)}  ${pct(s.reposts, s.n)}    ${pct(s.follows, s.n)}    ${pct(s.deletes, s.n)}  ${pct(s.other, s.n)}`);
}

if (samples.length) {
  const rates = samples.map((s) => s.rate);
  const total = samples.reduce((a, s) => a + s.n, 0);
  const sum = (f: (s: Sample) => number) => samples.reduce((a, s) => a + f(s), 0);
  const hi = samples.reduce((a, s) => (s.rate > a.rate ? s : a));
  const lo = samples.reduce((a, s) => (s.rate < a.rate ? s : a));
  const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
  console.log("\n=== Summary ===");
  console.log(`Average rate         ${avg.toFixed(0)} events/sec   (about ${(avg * 86400 / 1e6).toFixed(1)} million events/day)`);
  console.log(`Quietest hour        ${lo.rate.toFixed(0)} events/sec   at ${fmt(lo.at)} UTC (${local(lo.at)} local)`);
  console.log(`Busiest hour         ${hi.rate.toFixed(0)} events/sec   at ${fmt(hi.at)} UTC (${local(hi.at)} local)`);
  console.log(`Busiest single sec   ${Math.max(...samples.map((s) => s.peakSecond))} events`);
  console.log(`Average message      ${(sum((s) => s.avgBytes * s.n) / total).toFixed(0)} bytes   (about ${((avg * sum((s) => s.avgBytes * s.n)) / total / 1000).toFixed(0)} KB/sec)`);
  console.log(`Mix                  likes ${pct(sum((s) => s.likes), total).trim()}, posts ${pct(sum((s) => s.posts), total).trim()}, reposts ${pct(sum((s) => s.reposts), total).trim()}, follows ${pct(sum((s) => s.follows), total).trim()}, deletes ${pct(sum((s) => s.deletes), total).trim()}, other ${pct(sum((s) => s.other), total).trim()}`);
  console.log(`Per route at average engagement ${(avg * (sum((s) => s.likes + s.reposts) / total)).toFixed(0)}/s, posts ${(avg * (sum((s) => s.posts) / total)).toFixed(0)}/s, follows ${(avg * (sum((s) => s.follows) / total)).toFixed(0)}/s, deletions ${(avg * (sum((s) => s.deletes) / total)).toFixed(0)}/s`);
  console.log(`Samples              ${samples.length} points, ${total} events, each covering about ${(sum((s) => s.spanSec) / samples.length).toFixed(0)} s of stream time`);
}
process.exit(0);

// Throwaway probe: measure the Jetstream firehose for N seconds and print aggregate numbers.
// Not part of the service (tsconfig only includes src/). Run: npx tsx scripts/probe.ts [seconds]
// Deliberately never reads or prints record contents — only counts and sizes.

const URL = "wss://jetstream2.us-east.bsky.network/subscribe";
const seconds = Number(process.argv[2] ?? "60");

type Counter = Map<string, number>;
const bump = (m: Counter, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

const byKind: Counter = new Map();
const byCollection: Counter = new Map();
const byOperation: Counter = new Map();
const byCollectionOp: Counter = new Map();
const perSecond: number[] = [];

let total = 0;
let totalBytes = 0;
let maxBytes = 0;
let thisSecond = 0;
let firstTimeUs = 0;
let lastTimeUs = 0;
let outOfOrder = 0;

const startedAt = new Date();
const ws = new WebSocket(URL);

ws.onopen = () => console.error(`connected to ${URL} at ${startedAt.toISOString()}, sampling ${seconds}s...`);
ws.onerror = () => {
  console.error("websocket error");
  process.exit(1);
};
ws.onclose = (ev) => {
  if (!done) {
    console.error(`socket closed early (code ${ev.code})`);
    process.exit(1);
  }
};

ws.onmessage = (msg) => {
  const data = String(msg.data);
  const bytes = Buffer.byteLength(data);
  total++;
  thisSecond++;
  totalBytes += bytes;
  if (bytes > maxBytes) maxBytes = bytes;

  const ev = JSON.parse(data) as {
    kind?: string;
    time_us?: number;
    commit?: { collection?: string; operation?: string };
  };
  bump(byKind, ev.kind ?? "?");
  if (ev.commit) {
    const col = ev.commit.collection ?? "?";
    const op = ev.commit.operation ?? "?";
    bump(byCollection, col);
    bump(byOperation, op);
    bump(byCollectionOp, `${col} / ${op}`);
  }
  const t = ev.time_us ?? 0;
  if (firstTimeUs === 0) firstTimeUs = t;
  if (t < lastTimeUs) outOfOrder++;
  lastTimeUs = t;
};

const tick = setInterval(() => {
  perSecond.push(thisSecond);
  thisSecond = 0;
}, 1000);

let done = false;
setTimeout(() => {
  done = true;
  clearInterval(tick);
  ws.close();
  report();
  process.exit(0);
}, seconds * 1000);

function table(title: string, m: Counter, denom: number, minPct = 0.5) {
  const rows = [...m.entries()].sort((a, b) => b[1] - a[1]);
  const width = Math.max(...rows.map(([k]) => k.length), 10);
  console.log(`\n${title}`);
  console.log(`${"".padEnd(width)}  ${"count".padStart(7)}  ${"%".padStart(6)}`);
  const other: string[] = [];
  let otherCount = 0;
  for (const [k, n] of rows) {
    const pct = (100 * n) / denom;
    if (pct < minPct) {
      other.push(k);
      otherCount += n;
      continue;
    }
    console.log(`${k.padEnd(width)}  ${String(n).padStart(7)}  ${pct.toFixed(1).padStart(6)}`);
  }
  if (other.length) {
    const pct = (100 * otherCount) / denom;
    console.log(`${`other (${other.length} keys)`.padEnd(width)}  ${String(otherCount).padStart(7)}  ${pct.toFixed(1).padStart(6)}`);
    console.log(`  other = ${other.join(", ")}`);
  }
}

function report() {
  const secs = perSecond.length || seconds;
  const commits = byKind.get("commit") ?? 0;
  console.log(`\n=== Jetstream probe: ${startedAt.toISOString()} for ${secs}s ===`);
  console.log(`events total      ${total}`);
  console.log(`events/sec avg    ${(total / secs).toFixed(1)}`);
  console.log(`events/sec min    ${Math.min(...perSecond)}`);
  console.log(`events/sec max    ${Math.max(...perSecond)}`);
  console.log(`msg bytes avg     ${Math.round(totalBytes / total)}`);
  console.log(`msg bytes max     ${maxBytes}`);
  console.log(`bytes/sec avg     ${Math.round(totalBytes / secs)}`);
  console.log(`time_us span      ${((lastTimeUs - firstTimeUs) / 1e6).toFixed(1)}s (out-of-order: ${outOfOrder})`);
  table("by kind", byKind, total);
  table("by operation (commits only)", byOperation, commits);
  table("by collection (commits only)", byCollection, commits);
  table("by collection / operation (commits only)", byCollectionOp, commits);
}

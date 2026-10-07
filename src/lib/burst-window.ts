// Sliding-window threshold detector shared by the engagement and follow routes.
//
// Question it answers: "has `key` seen at least `threshold` events within the last `windowMs`,
// and have we not already said so in this window?"
//
// Time is whatever the caller passes in (we use the event's own time_us, see decision 10), so
// this class has no timers and no clock: it is a pure function of its inputs and trivially
// testable with explicit timestamps.
//
// Memory is bounded two ways (decision 6):
// - per key: at most `threshold` timestamps. To know whether the N-th most recent event is
//   inside the window you never need more than N timestamps, so the answer stays exact.
// - across keys: a sweep once per window drops keys whose newest event has left the window, and
//   a hard cap evicts the least-recently-touched key. The Map doubles as the LRU: deleting and
//   re-inserting a key on touch moves it to the end, so the first key is always the coldest.
//
// Window semantics: an event is inside the window if  now - windowMs < t <= now.
// An event exactly windowMs old has left the window.

export interface BurstWindowOptions {
  windowMs: number;
  threshold: number;
  maxKeys: number;
}

export interface BurstResult {
  count: number; // events for this key inside the window, capped at threshold
  fired: boolean; // true at most once per key per window
}

interface Entry {
  times: number[]; // ascending, length <= threshold
  firedAt: number | undefined;
}

export class BurstWindow {
  private readonly entries = new Map<string, Entry>();
  private lastSweepAt = -Infinity;
  private evictions = 0;

  constructor(readonly opts: BurstWindowOptions) {
    if (opts.threshold < 1 || opts.windowMs < 1 || opts.maxKeys < 1) throw new Error("BurstWindow: threshold, windowMs and maxKeys must be >= 1");
  }

  record(key: string, nowMs: number): BurstResult {
    this.maybeSweep(nowMs);

    let entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key); // re-insert below: LRU touch
    } else {
      entry = { times: [], firedAt: undefined };
    }
    this.entries.set(key, entry);
    if (this.entries.size > this.opts.maxKeys) this.evictColdest();

    const cutoff = nowMs - this.opts.windowMs;
    const times = entry.times;
    // Drop what has left the window. Times are ascending, so this is a scan from the front.
    let drop = 0;
    while (drop < times.length && times[drop]! <= cutoff) drop++;
    if (drop > 0) times.splice(0, drop);

    times.push(nowMs);
    if (times.length > this.opts.threshold) times.shift(); // keep the newest `threshold`

    const count = times.length;
    const alreadyFired = entry.firedAt !== undefined && nowMs - entry.firedAt < this.opts.windowMs;
    const fired = count >= this.opts.threshold && !alreadyFired;
    if (fired) entry.firedAt = nowMs;
    return { count, fired };
  }

  get keyCount(): number {
    return this.entries.size;
  }

  get evictionCount(): number {
    return this.evictions;
  }

  // Runs once per window. Cost is O(keys) on the event loop; at ~50k keys that is a few
  // milliseconds once a minute, which is why it is not done per event.
  private maybeSweep(nowMs: number): void {
    if (nowMs - this.lastSweepAt < this.opts.windowMs) return;
    this.lastSweepAt = nowMs;
    const cutoff = nowMs - this.opts.windowMs;
    for (const [key, entry] of this.entries) {
      const newest = entry.times[entry.times.length - 1];
      if (newest === undefined || newest <= cutoff) this.entries.delete(key);
    }
  }

  private evictColdest(): void {
    const coldest = this.entries.keys().next().value;
    if (coldest !== undefined) {
      this.entries.delete(coldest);
      this.evictions++;
    }
  }
}

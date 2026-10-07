import { describe, expect, it } from "vitest";
import { BurstWindow } from "../burst-window.js";

// Explicit timestamps throughout: the detector has no clock of its own (decision 10).
// threshold 3, window 1000 ms unless stated.
const make = (opts: Partial<ConstructorParameters<typeof BurstWindow>[0]> = {}) =>
  new BurstWindow({ threshold: 3, windowMs: 1000, maxKeys: 100, ...opts });

describe("BurstWindow", () => {
  it("fires on exactly the N-th event inside the window, not before", () => {
    const w = make();
    expect(w.record("k", 0)).toEqual({ count: 1, fired: false });
    expect(w.record("k", 10)).toEqual({ count: 2, fired: false });
    expect(w.record("k", 20)).toEqual({ count: 3, fired: true });
  });

  it("an event exactly windowMs old has left the window; one ms newer is still inside", () => {
    const outside = make();
    outside.record("k", 0);
    outside.record("k", 500);
    expect(outside.record("k", 1000)).toEqual({ count: 2, fired: false }); // t=0 is exactly 1000 old → out

    const inside = make();
    inside.record("k", 0);
    inside.record("k", 500);
    expect(inside.record("k", 999)).toEqual({ count: 3, fired: true }); // t=0 is 999 old → in
  });

  it("fires once per key per window, then again once the window has passed", () => {
    const w = make();
    w.record("k", 0);
    w.record("k", 10);
    expect(w.record("k", 20).fired).toBe(true);
    expect(w.record("k", 30)).toEqual({ count: 3, fired: false }); // still over threshold, already alerted
    expect(w.record("k", 40).fired).toBe(false);
    // A full window later the old events are gone and a fresh burst alerts again.
    w.record("k", 1030);
    w.record("k", 1040);
    expect(w.record("k", 1050)).toEqual({ count: 3, fired: true });
  });

  it("does not re-fire at the window edge if the count only persists from the earlier burst", () => {
    const w = make();
    w.record("k", 0);
    w.record("k", 10);
    w.record("k", 20); // fires
    // 1000 ms after firing the dedupe expires, but by then t=0,10,20 have left the window too.
    expect(w.record("k", 1020)).toEqual({ count: 1, fired: false });
  });

  it("keys are independent", () => {
    const w = make();
    w.record("a", 0);
    w.record("a", 1);
    w.record("b", 2);
    expect(w.record("b", 3)).toEqual({ count: 2, fired: false });
    expect(w.record("a", 4)).toEqual({ count: 3, fired: true });
  });

  it("never keeps more than `threshold` timestamps per key", () => {
    const w = make();
    for (let t = 0; t < 50; t++) {
      const { count } = w.record("hot", t);
      expect(count).toBeLessThanOrEqual(3);
    }
  });

  it("evicts the least-recently-touched key when over maxKeys, not the oldest-inserted", () => {
    const w = make({ maxKeys: 2 });
    w.record("a", 0);
    w.record("b", 1);
    w.record("a", 2); // touch a: b is now the coldest
    w.record("c", 3); // over cap → b evicted
    expect(w.keyCount).toBe(2);
    expect(w.evictionCount).toBe(1);
    expect(w.record("a", 4)).toEqual({ count: 3, fired: true }); // a kept its history
    expect(w.record("b", 5)).toEqual({ count: 1, fired: false }); // b starts over
  });

  it("sweeps idle keys once per window", () => {
    const w = make();
    w.record("a", 0);
    w.record("b", 0);
    expect(w.keyCount).toBe(2);
    w.record("c", 999); // less than a window since the last sweep: nothing swept yet
    expect(w.keyCount).toBe(3);
    w.record("d", 1000); // a window has passed: a and b (newest event at 0) are gone
    expect(w.keyCount).toBe(2);
  });

  it("rejects nonsense options", () => {
    expect(() => make({ threshold: 0 })).toThrow();
    expect(() => make({ windowMs: 0 })).toThrow();
    expect(() => make({ maxKeys: 0 })).toThrow();
  });
});

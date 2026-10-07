import { describe, expect, it } from "vitest";
import { BoundedQueue } from "../bounded-queue.js";

describe("BoundedQueue", () => {
  it("is FIFO and refuses when full", async () => {
    const q = new BoundedQueue<number>(3);
    expect(q.tryEnqueue(1)).toBe(true);
    expect(q.tryEnqueue(2)).toBe(true);
    expect(q.tryEnqueue(3)).toBe(true);
    expect(q.tryEnqueue(4)).toBe(false); // full: caller decides (router counts a drop)
    expect(q.size).toBe(3);
    expect(await q.take()).toBe(1);
    expect(q.tryEnqueue(4)).toBe(true); // room again, ring wraps
    expect(await q.take()).toBe(2);
    expect(await q.take()).toBe(3);
    expect(await q.take()).toBe(4);
    expect(q.size).toBe(0);
  });

  it("hands an item straight to a waiting taker without buffering", async () => {
    const q = new BoundedQueue<string>(1);
    const pending = q.take(); // nothing there yet: parks a waiter
    expect(q.tryEnqueue("a")).toBe(true);
    expect(q.size).toBe(0); // went to the waiter, not the buffer
    expect(await pending).toBe("a");
  });

  it("close wakes waiting takers with undefined and rejects new items", async () => {
    const q = new BoundedQueue<string>(2);
    const pending = q.take();
    q.close();
    expect(await pending).toBeUndefined();
    expect(q.tryEnqueue("late")).toBe(false);
  });

  it("after close, buffered items are still drained before undefined", async () => {
    const q = new BoundedQueue<string>(2);
    q.tryEnqueue("a");
    q.tryEnqueue("b");
    q.close();
    expect(await q.take()).toBe("a");
    expect(await q.take()).toBe("b");
    expect(await q.take()).toBeUndefined();
  });

  it("rejects a capacity below 1", () => {
    expect(() => new BoundedQueue(0)).toThrow();
  });
});

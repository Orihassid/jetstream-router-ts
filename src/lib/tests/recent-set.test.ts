import { describe, expect, it } from "vitest";
import { RecentSet } from "../recent-set.js";

describe("RecentSet", () => {
  it("reports duplicates and forgets the oldest member when full", () => {
    const s = new RecentSet(2);
    expect(s.add("a")).toBe(true);
    expect(s.add("a")).toBe(false);
    expect(s.add("b")).toBe(true);
    expect(s.add("c")).toBe(true); // evicts a
    expect(s.size).toBe(2);
    expect(s.has("a")).toBe(false);
    expect(s.has("b")).toBe(true);
    expect(s.add("a")).toBe(true); // a is new again
  });

  it("rejects a size below 1", () => {
    expect(() => new RecentSet(0)).toThrow();
  });
});

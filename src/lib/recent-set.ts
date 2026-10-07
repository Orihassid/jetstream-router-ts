// A bounded set that forgets its oldest member once full. Used to suppress duplicate
// notifications after a cursor rewind (at-least-once delivery). A Set keeps insertion order,
// so the oldest key is always the first one iterated: eviction is O(1), no timestamps needed.
export class RecentSet {
  private readonly set = new Set<string>();

  constructor(private readonly max: number) {
    if (max < 1) throw new Error("RecentSet: max must be >= 1");
  }

  has(key: string): boolean {
    return this.set.has(key);
  }

  // Returns true if the key was new.
  add(key: string): boolean {
    if (this.set.has(key)) return false;
    this.set.add(key);
    if (this.set.size > this.max) {
      const oldest = this.set.values().next().value;
      if (oldest !== undefined) this.set.delete(oldest);
    }
    return true;
  }

  get size(): number {
    return this.set.size;
  }
}

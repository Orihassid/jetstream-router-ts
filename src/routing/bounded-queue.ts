// A fixed-capacity FIFO with a synchronous producer side and an async consumer side.
//
// Producer: tryEnqueue() never waits. It returns false when full, and the caller decides what
// that means (the router counts a drop). This is what keeps backpressure real in Node: an
// awaiting producer would not slow the WebSocket down, it would just park promises in memory.
//
// Consumer: take() resolves with the next item, or waits until one arrives. After close() it
// keeps handing out buffered items until empty, then resolves undefined forever.
//
// Storage is a ring buffer so both ends are O(1); Array.shift() would be O(n) at 10k items.

export class BoundedQueue<T> {
  private readonly buf: (T | undefined)[];
  private head = 0; // next item to take
  private tail = 0; // next free slot
  private count = 0;
  private closed = false;
  private readonly waiters: Array<(item: T | undefined) => void> = [];

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error(`BoundedQueue: capacity must be >= 1, got ${capacity}`);
    this.buf = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.count;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  tryEnqueue(item: T): boolean {
    if (this.closed) return false;
    // An idle worker is waiting: hand the item straight over. Its promise resolves on the
    // microtask queue, so the worker runs only after the current synchronous dispatch returns.
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
      return true;
    }
    if (this.count === this.capacity) return false;
    this.buf[this.tail] = item;
    this.tail = (this.tail + 1) % this.capacity;
    this.count++;
    return true;
  }

  take(): Promise<T | undefined> {
    if (this.count > 0) {
      const item = this.buf[this.head];
      this.buf[this.head] = undefined; // do not keep a reference alive
      this.head = (this.head + 1) % this.capacity;
      this.count--;
      return Promise.resolve(item);
    }
    if (this.closed) return Promise.resolve(undefined);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    this.closed = true;
    // Wake everyone waiting on an empty queue so worker loops can exit.
    for (const waiter of this.waiters.splice(0)) waiter(undefined);
  }
}

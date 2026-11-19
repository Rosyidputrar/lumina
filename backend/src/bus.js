/** Tiny synchronous event bus used to stream state to SSE clients. */
export class EventBus {
  constructor() {
    this.listeners = new Set();
    this.seq = 0;
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type, payload) {
    const event = { seq: ++this.seq, type, ts: Date.now(), payload };
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        /* a dead SSE client must never break the trading loop */
      }
    }
    return event;
  }
}

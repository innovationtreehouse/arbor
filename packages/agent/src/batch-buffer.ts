export interface BatchEvent {
  channel: string;
  thread_ts: string;
  event_ts: string;
  user: string;
  text: string;
}

type FlushFn = (events: BatchEvent[]) => Promise<void>;

/**
 * Buffers Slack events per channel and flushes them as a batch after
 * flushIntervalMs. The first event for a channel starts a single timer;
 * subsequent events within the window are appended to the same buffer.
 * When the timer fires the entire buffer is handed to onFlush and cleared.
 */
export class BatchBuffer {
  private readonly buffers = new Map<string, BatchEvent[]>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly flushIntervalMs: number,
    private readonly onFlush: FlushFn,
  ) {}

  /** Append an event to the channel buffer, starting the flush timer if needed. */
  add(event: BatchEvent): void {
    let buf = this.buffers.get(event.channel);
    if (!buf) {
      buf = [];
      this.buffers.set(event.channel, buf);
    }
    buf.push(event);

    if (!this.timers.has(event.channel)) {
      const timer = setTimeout(
        () => void this._flush(event.channel),
        this.flushIntervalMs,
      );
      this.timers.set(event.channel, timer);
    }
  }

  /** Number of events waiting to be flushed for a channel. */
  size(channel: string): number {
    return this.buffers.get(channel)?.length ?? 0;
  }

  /** True if a flush timer is currently running for the channel. */
  hasPendingFlush(channel: string): boolean {
    return this.timers.has(channel);
  }

  /**
   * Cancel all pending timers and flush every buffer immediately.
   * Call on shutdown to avoid dropping buffered events.
   */
  async flushAll(): Promise<void> {
    for (const [channel, timer] of this.timers) {
      clearTimeout(timer);
      this.timers.delete(channel);
    }
    for (const channel of [...this.buffers.keys()]) {
      await this._flush(channel);
    }
  }

  private async _flush(channel: string): Promise<void> {
    this.timers.delete(channel);
    const events = this.buffers.get(channel) ?? [];
    this.buffers.delete(channel);
    if (events.length > 0) {
      await this.onFlush(events);
    }
  }
}

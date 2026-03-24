import type { ConfigStore } from "@arbor/db";

export const RATE_WINDOW_MS = 60_000;
export const RATE_THRESHOLD = 3;

/**
 * Tracks per-channel mention timestamps in ConfigStore and detects when a
 * channel enters holdoff (≥ threshold mentions within the rolling window).
 *
 * State is persisted so it survives across Lambda invocations.
 */
export class ChannelRateLimiter {
  constructor(
    private readonly configStore: ConfigStore,
    readonly windowMs = RATE_WINDOW_MS,
    readonly threshold = RATE_THRESHOLD,
  ) {}

  /**
   * Records a new mention for the channel at nowMs and returns true if the
   * channel has reached or exceeded the threshold within the window.
   */
  async recordAndCheck(channel: string, nowMs = Date.now()): Promise<boolean> {
    const key = `rate:${channel}`;
    const raw = await this.configStore.get(key);
    const timestamps: number[] = raw ? JSON.parse(raw) : [];

    const windowStart = nowMs - this.windowMs;
    const recent = timestamps.filter((t) => t > windowStart);
    recent.push(nowMs);

    await this.configStore.set(key, JSON.stringify(recent));

    return recent.length >= this.threshold;
  }
}

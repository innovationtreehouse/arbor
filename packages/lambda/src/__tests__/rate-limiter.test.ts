import { describe, expect, it, vi } from "vitest";
import { ChannelRateLimiter, RATE_THRESHOLD, RATE_WINDOW_MS } from "../rate-limiter.js";
import type { ConfigStore } from "@arbor/db";

function makeStore(initial: Record<string, string> = {}): ConfigStore {
  const data = { ...initial };
  return {
    get: vi.fn(async (key: string) => data[key]),
    set: vi.fn(async (key: string, value: string) => { data[key] = value; }),
  };
}

const CH = "C_TEST";

describe("ChannelRateLimiter", () => {
  it("returns false for the first mention", async () => {
    const limiter = new ChannelRateLimiter(makeStore());
    expect(await limiter.recordAndCheck(CH)).toBe(false);
  });

  it("returns false for the second mention", async () => {
    const store = makeStore();
    const limiter = new ChannelRateLimiter(store);
    await limiter.recordAndCheck(CH, 1000);
    expect(await limiter.recordAndCheck(CH, 2000)).toBe(false);
  });

  it(`returns true on the ${RATE_THRESHOLD}th mention within the window`, async () => {
    const store = makeStore();
    const limiter = new ChannelRateLimiter(store);
    const now = 10_000;
    await limiter.recordAndCheck(CH, now);
    await limiter.recordAndCheck(CH, now + 1000);
    expect(await limiter.recordAndCheck(CH, now + 2000)).toBe(true);
  });

  it("returns true for every mention beyond the threshold", async () => {
    const store = makeStore();
    const limiter = new ChannelRateLimiter(store);
    const now = 10_000;
    for (let i = 0; i < RATE_THRESHOLD; i++) {
      await limiter.recordAndCheck(CH, now + i * 100);
    }
    expect(await limiter.recordAndCheck(CH, now + 5000)).toBe(true);
    expect(await limiter.recordAndCheck(CH, now + 6000)).toBe(true);
  });

  it("resets holdoff once old timestamps slide outside the window", async () => {
    const store = makeStore();
    const limiter = new ChannelRateLimiter(store);
    const now = 10_000;
    // Three rapid mentions → holdoff
    for (let i = 0; i < RATE_THRESHOLD; i++) {
      await limiter.recordAndCheck(CH, now + i * 100);
    }
    // Well past the window — those timestamps should be pruned
    expect(await limiter.recordAndCheck(CH, now + RATE_WINDOW_MS + 10_000)).toBe(false);
  });

  it("prunes timestamps older than the window on each call", async () => {
    const store = makeStore();
    const limiter = new ChannelRateLimiter(store);
    const now = 50_000;
    // Two old mentions
    await limiter.recordAndCheck(CH, now - RATE_WINDOW_MS - 5000);
    await limiter.recordAndCheck(CH, now - RATE_WINDOW_MS - 1000);
    // One recent mention — still only 1 in window, not in holdoff
    expect(await limiter.recordAndCheck(CH, now)).toBe(false);
  });

  it("tracks channels independently", async () => {
    const store = makeStore();
    const limiter = new ChannelRateLimiter(store);
    const now = 10_000;
    // Flood channel A
    for (let i = 0; i < RATE_THRESHOLD; i++) {
      await limiter.recordAndCheck("C_A", now + i * 100);
    }
    // Channel B should still be below threshold
    expect(await limiter.recordAndCheck("C_B", now + 5000)).toBe(false);
  });

  it("persists state between instances sharing the same store", async () => {
    const store = makeStore();
    const t = 10_000;
    await new ChannelRateLimiter(store).recordAndCheck(CH, t);
    await new ChannelRateLimiter(store).recordAndCheck(CH, t + 1000);
    // Third call on a fresh instance sees the previous state
    expect(await new ChannelRateLimiter(store).recordAndCheck(CH, t + 2000)).toBe(true);
  });

  it("respects a custom threshold", async () => {
    const store = makeStore();
    const limiter = new ChannelRateLimiter(store, RATE_WINDOW_MS, 5);
    const now = 10_000;
    for (let i = 0; i < 4; i++) {
      expect(await limiter.recordAndCheck(CH, now + i * 100)).toBe(false);
    }
    expect(await limiter.recordAndCheck(CH, now + 5000)).toBe(true);
  });

  it("respects a custom window", async () => {
    const SHORT_WINDOW = 5_000;
    const store = makeStore();
    const limiter = new ChannelRateLimiter(store, SHORT_WINDOW);
    const now = 10_000;
    // Two quick mentions
    await limiter.recordAndCheck(CH, now);
    await limiter.recordAndCheck(CH, now + 1000);
    // Third mention is outside the short window — only 1 recent, no holdoff
    expect(await limiter.recordAndCheck(CH, now + SHORT_WINDOW + 1)).toBe(false);
  });
});

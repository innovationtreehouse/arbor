import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BatchBuffer, type BatchEvent } from "../batch-buffer.js";

function makeEvent(channel: string, n: number): BatchEvent {
  return { channel, thread_ts: "1.0", event_ts: String(n), user: "U1", text: `msg${n}` };
}

describe("BatchBuffer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not flush before the interval elapses", async () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const buf = new BatchBuffer(60_000, onFlush);
    buf.add(makeEvent("C1", 1));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(onFlush).not.toHaveBeenCalled();
  });

  it("flushes all events for a channel after the interval", async () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const buf = new BatchBuffer(60_000, onFlush);
    buf.add(makeEvent("C1", 1));
    buf.add(makeEvent("C1", 2));
    buf.add(makeEvent("C1", 3));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onFlush).toHaveBeenCalledOnce();
    const [flushed] = onFlush.mock.calls[0];
    expect(flushed).toHaveLength(3);
    expect(flushed.map((e: BatchEvent) => e.event_ts)).toEqual(["1", "2", "3"]);
  });

  it("clears the buffer after flush — size returns 0", async () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const buf = new BatchBuffer(60_000, onFlush);
    buf.add(makeEvent("C1", 1));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(buf.size("C1")).toBe(0);
  });

  it("does not call onFlush when buffer is empty at flush time", async () => {
    // Manually calling _flush via flushAll on an empty buffer
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const buf = new BatchBuffer(60_000, onFlush);
    await buf.flushAll();
    expect(onFlush).not.toHaveBeenCalled();
  });

  it("size reflects buffered event count before flush", () => {
    const buf = new BatchBuffer(60_000, vi.fn());
    expect(buf.size("C1")).toBe(0);
    buf.add(makeEvent("C1", 1));
    expect(buf.size("C1")).toBe(1);
    buf.add(makeEvent("C1", 2));
    expect(buf.size("C1")).toBe(2);
  });

  it("hasPendingFlush is true after first add, false before any add", () => {
    const buf = new BatchBuffer(60_000, vi.fn());
    expect(buf.hasPendingFlush("C1")).toBe(false);
    buf.add(makeEvent("C1", 1));
    expect(buf.hasPendingFlush("C1")).toBe(true);
  });

  it("hasPendingFlush is false after the timer fires", async () => {
    const buf = new BatchBuffer(60_000, vi.fn().mockResolvedValue(undefined));
    buf.add(makeEvent("C1", 1));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(buf.hasPendingFlush("C1")).toBe(false);
  });

  it("a single timer covers all events added before it fires", async () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const buf = new BatchBuffer(60_000, onFlush);
    buf.add(makeEvent("C1", 1));
    await vi.advanceTimersByTimeAsync(30_000);
    buf.add(makeEvent("C1", 2)); // halfway through — no second timer started
    await vi.advanceTimersByTimeAsync(30_000); // original timer fires
    expect(onFlush).toHaveBeenCalledOnce();
    expect(onFlush.mock.calls[0][0]).toHaveLength(2);
  });

  it("after a flush, a new add starts a fresh timer", async () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const buf = new BatchBuffer(60_000, onFlush);
    buf.add(makeEvent("C1", 1));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onFlush).toHaveBeenCalledOnce();

    buf.add(makeEvent("C1", 2));
    expect(buf.hasPendingFlush("C1")).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(onFlush.mock.calls[1][0][0].event_ts).toBe("2");
  });

  it("buffers different channels independently", async () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const buf = new BatchBuffer(60_000, onFlush);
    buf.add(makeEvent("C_A", 1));
    buf.add(makeEvent("C_B", 2));
    expect(buf.size("C_A")).toBe(1);
    expect(buf.size("C_B")).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onFlush).toHaveBeenCalledTimes(2);
  });

  it("flushAll cancels timers and delivers all buffered events immediately", async () => {
    const onFlush = vi.fn().mockResolvedValue(undefined);
    const buf = new BatchBuffer(60_000, onFlush);
    buf.add(makeEvent("C_A", 1));
    buf.add(makeEvent("C_B", 2));
    await buf.flushAll();
    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(buf.size("C_A")).toBe(0);
    expect(buf.size("C_B")).toBe(0);
    // No more timers — advancing time fires nothing
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onFlush).toHaveBeenCalledTimes(2);
  });

  it("flushAll delivers events in buffer order", async () => {
    const received: BatchEvent[] = [];
    const onFlush = vi.fn(async (events: BatchEvent[]) => { received.push(...events); });
    const buf = new BatchBuffer(60_000, onFlush);
    buf.add(makeEvent("C1", 1));
    buf.add(makeEvent("C1", 2));
    buf.add(makeEvent("C1", 3));
    await buf.flushAll();
    expect(received.map((e) => e.event_ts)).toEqual(["1", "2", "3"]);
  });
});

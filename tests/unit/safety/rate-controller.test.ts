import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RateController } from "../../../src/safety/rate-controller.js";

describe("RateController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("T-RC2-001: disabled mode returns immediately", async () => {
    const rc = new RateController(false, 60_000, 150, 0.1);
    const start = Date.now();
    await rc.waitIfNeeded();
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("T-RC2-002: inserts cooldown when too soon", async () => {
    const rc = new RateController(true, 60_000, 150, 0.1);
    await rc.waitIfNeeded();
    const promise = rc.waitIfNeeded();
    vi.advanceTimersByTime(60_000);
    await promise;
    // Should have waited ~60s
  });

  it("T-RC2-003: no cooldown when enough time passed", async () => {
    const rc = new RateController(true, 60_000, 150, 0.1);
    await rc.waitIfNeeded();
    vi.advanceTimersByTime(90_000);
    const start = Date.now();
    await rc.waitIfNeeded();
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("T-RC2-004: blocks when window limit reached", async () => {
    const rc = new RateController(true, 0, 3, 0.1); // max 3 tasks, no cooldown
    await rc.waitIfNeeded();
    await rc.waitIfNeeded();
    await rc.waitIfNeeded();
    // 4th call should block
    const promise = rc.waitIfNeeded();
    vi.advanceTimersByTime(5 * 3600_000); // advance past window
    await promise;
  });

  it("T-RC2-005: resets window after 5 hours", async () => {
    const rc = new RateController(true, 0, 150, 0.1);
    await rc.waitIfNeeded();
    expect(rc.getTasksInWindow()).toBe(1);
    vi.advanceTimersByTime(5 * 3600_000 + 1);
    await rc.waitIfNeeded();
    // Window should have reset, count is 1 (not 2)
    expect(rc.getTasksInWindow()).toBe(1);
  });

  it("T-RC2-006: increments task count", async () => {
    const rc = new RateController(true, 0, 150, 0.1);
    expect(rc.getTasksInWindow()).toBe(0);
    await rc.waitIfNeeded();
    expect(rc.getTasksInWindow()).toBe(1);
    await rc.waitIfNeeded();
    expect(rc.getTasksInWindow()).toBe(2);
  });

  it("T-RC2-007: warns when approaching limit (10%)", async () => {
    const onWarn = vi.fn();
    const rc = new RateController(true, 0, 10, 0.1, onWarn); // max 10, warn at 90%
    for (let i = 0; i < 9; i++) {
      await rc.waitIfNeeded();
    }
    expect(onWarn).toHaveBeenCalled();
  });

  it("T-RC2-008: updates lastTaskTime", async () => {
    const rc = new RateController(true, 0, 150, 0.1);
    const before = rc.getLastTaskTime();
    vi.advanceTimersByTime(1000);
    await rc.waitIfNeeded();
    expect(rc.getLastTaskTime()).toBeGreaterThan(before);
  });
});

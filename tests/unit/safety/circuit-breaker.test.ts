import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CircuitBreaker } from "../../../src/safety/circuit-breaker.js";

describe("CircuitBreaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("T-CB2-001: initial state is CLOSED", () => {
    const cb = new CircuitBreaker(5, 3_600_000);
    expect(cb.getState()).toBe("CLOSED");
  });

  it("T-CB2-002: success resets counter", () => {
    const cb = new CircuitBreaker(5, 3_600_000);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    expect(cb.getConsecutiveFailures()).toBe(0);
  });

  it("T-CB2-003: failure increments counter", () => {
    const cb = new CircuitBreaker(5, 3_600_000);
    cb.recordFailure();
    expect(cb.getConsecutiveFailures()).toBe(1);
  });

  it("T-CB2-004: 5 consecutive failures open circuit", () => {
    const onOpen = vi.fn();
    const cb = new CircuitBreaker(5, 3_600_000, onOpen);
    for (let i = 0; i < 5; i++) cb.recordFailure();
    expect(cb.getState()).toBe("OPEN");
    expect(onOpen).toHaveBeenCalled();
  });

  it("T-CB2-005: OPEN state rejects execution", () => {
    const cb = new CircuitBreaker(5, 3_600_000);
    for (let i = 0; i < 5; i++) cb.recordFailure();
    expect(cb.canExecute()).toBe(false);
  });

  it("T-CB2-006: transitions to HALF_OPEN after timeout", () => {
    const cb = new CircuitBreaker(5, 3_600_000);
    for (let i = 0; i < 5; i++) cb.recordFailure();
    expect(cb.getState()).toBe("OPEN");
    vi.advanceTimersByTime(3_600_000 + 1);
    expect(cb.canExecute()).toBe(true);
    expect(cb.getState()).toBe("HALF_OPEN");
  });

  it("T-CB2-007: HALF_OPEN success → CLOSED", () => {
    const onClose = vi.fn();
    const cb = new CircuitBreaker(5, 3_600_000, undefined, onClose);
    for (let i = 0; i < 5; i++) cb.recordFailure();
    vi.advanceTimersByTime(3_600_001);
    cb.canExecute(); // transition to HALF_OPEN
    cb.recordSuccess();
    expect(cb.getState()).toBe("CLOSED");
    expect(onClose).toHaveBeenCalled();
  });

  it("T-CB2-008: HALF_OPEN failure → OPEN", () => {
    const cb = new CircuitBreaker(5, 3_600_000);
    for (let i = 0; i < 5; i++) cb.recordFailure();
    vi.advanceTimersByTime(3_600_001);
    cb.canExecute(); // HALF_OPEN
    cb.recordFailure();
    expect(cb.getState()).toBe("OPEN");
  });

  it("T-CB2-009: interleaved success resets counter", () => {
    const cb = new CircuitBreaker(5, 3_600_000);
    cb.recordSuccess();
    cb.recordFailure();
    cb.recordSuccess();
    expect(cb.getConsecutiveFailures()).toBe(0);
    expect(cb.getState()).toBe("CLOSED");
  });

  it("T-CB2-010: remaining ms calculation", () => {
    const cb = new CircuitBreaker(5, 3_600_000);
    for (let i = 0; i < 5; i++) cb.recordFailure();
    vi.advanceTimersByTime(1_800_000); // 30 min
    const remaining = cb.getRemainingMs();
    expect(remaining).toBeGreaterThan(1_700_000);
    expect(remaining).toBeLessThanOrEqual(1_800_000);
  });
});

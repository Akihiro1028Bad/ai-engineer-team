import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BudgetGuard } from "../../../src/safety/budget-guard.js";

describe("BudgetGuard", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("T-BG-001: allows when within budget", () => {
    const bg = new BudgetGuard(10.0);
    bg.recordCost(5.0);
    expect(bg.canExecute()).toBe(true);
  });

  it("T-BG-002: blocks when budget exceeded", () => {
    const onBudgetReached = vi.fn();
    const bg = new BudgetGuard(10.0, onBudgetReached);
    bg.recordCost(10.5);
    expect(bg.canExecute()).toBe(false);
    expect(onBudgetReached).toHaveBeenCalled();
  });

  it("T-BG-003: always allows when disabled (no limit)", () => {
    const bg = new BudgetGuard(undefined);
    bg.recordCost(999);
    expect(bg.canExecute()).toBe(true);
  });

  it("T-BG-004: accumulates costs", () => {
    const bg = new BudgetGuard(10.0);
    bg.recordCost(3.0);
    bg.recordCost(4.0);
    expect(bg.getDailySpent()).toBeCloseTo(7.0);
  });

  it("T-BG-005: resets daily", () => {
    const bg = new BudgetGuard(10.0);
    bg.recordCost(8.0);
    // Advance to next day
    vi.advanceTimersByTime(24 * 3_600_000 + 1);
    bg.checkDailyReset();
    expect(bg.getDailySpent()).toBe(0);
  });

  it("T-BG-006: blocks at exact limit", () => {
    const bg = new BudgetGuard(10.0);
    bg.recordCost(10.0);
    expect(bg.canExecute()).toBe(false);
  });
});

import { describe, it, expect, vi } from "vitest";
import { StatusEmitter } from "../../../src/execution/status-emitter.js";
import type { TaskEvent } from "../../../src/execution/status-emitter.js";

describe("StatusEmitter", () => {
  it("emits task started events", () => {
    const emitter = new StatusEmitter();
    const events: TaskEvent[] = [];
    emitter.onStatus((e) => events.push(e));

    emitter.emitTaskStarted("task-1", "designer", "plan-1");

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("task_started");
    expect(events[0]!.taskId).toBe("task-1");
    expect(events[0]!.agentRole).toBe("designer");
  });

  it("emits node lifecycle events", () => {
    const emitter = new StatusEmitter();
    const events: TaskEvent[] = [];
    emitter.onStatus((e) => events.push(e));

    emitter.emitNodeStarted("task-1", "plan-1", "node-1", "implementer");
    emitter.emitNodeCompleted("task-1", "plan-1", "node-1", "implementer", { cost: 1.5 });

    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe("node_started");
    expect(events[1]!.type).toBe("node_completed");
    expect(events[1]!.data?.["cost"]).toBe(1.5);
  });

  it("emits failure events with error details", () => {
    const emitter = new StatusEmitter();
    const events: TaskEvent[] = [];
    emitter.onStatus((e) => events.push(e));

    emitter.emitNodeFailed("task-1", "plan-1", "node-1", "critic", "Timeout");
    emitter.emitTaskFailed("task-1", "All retries exhausted");

    expect(events).toHaveLength(2);
    expect(events[0]!.data?.["error"]).toBe("Timeout");
    expect(events[1]!.type).toBe("task_failed");
  });

  it("emits progress events", () => {
    const emitter = new StatusEmitter();
    const events: TaskEvent[] = [];
    emitter.onStatus((e) => events.push(e));

    emitter.emitProgress("task-1", "バッチ 2/3 実行中");

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("task_progress");
    expect(events[0]!.message).toContain("バッチ 2/3");
  });

  it("supports multiple listeners", () => {
    const emitter = new StatusEmitter();
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    emitter.onStatus(listener1);
    emitter.onStatus(listener2);

    emitter.emitTaskStarted("task-1", "analyzer");

    expect(listener1).toHaveBeenCalledOnce();
    expect(listener2).toHaveBeenCalledOnce();
  });

  it("includes timestamp in all events", () => {
    const emitter = new StatusEmitter();
    const events: TaskEvent[] = [];
    emitter.onStatus((e) => events.push(e));

    emitter.emitTaskStarted("task-1", "designer");

    expect(events[0]!.timestamp).toBeDefined();
    expect(new Date(events[0]!.timestamp).getTime()).toBeGreaterThan(0);
  });
});

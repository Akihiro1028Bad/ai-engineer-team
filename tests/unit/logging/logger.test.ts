import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import { createLogger } from "../../../src/logging/logger.js";

function createMemoryStream(): { stream: Writable; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString().trim());
      callback();
    },
  });
  return { stream, lines };
}

describe("createLogger", () => {
  it("T-LOG-001: returns a pino logger instance", () => {
    const { stream } = createMemoryStream();
    const logger = createLogger({ stream });
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.error).toBe("function");
  });

  it("T-LOG-002: child logger includes context fields", () => {
    const { stream, lines } = createMemoryStream();
    const logger = createLogger({ stream, level: "info" });
    const child = logger.child({ taskId: "gh-42", agentRole: "reviewer" });
    child.info("test message");
    expect(lines.length).toBe(1);
    const parsed: unknown = JSON.parse(lines[0]!);
    expect(parsed).toHaveProperty("taskId", "gh-42");
    expect(parsed).toHaveProperty("agentRole", "reviewer");
  });

  it("T-LOG-003: debug level is suppressed at info level", () => {
    const { stream, lines } = createMemoryStream();
    const logger = createLogger({ stream, level: "info" });
    logger.debug("should not appear");
    expect(lines.length).toBe(0);
  });

  it("T-LOG-004: info level outputs", () => {
    const { stream, lines } = createMemoryStream();
    const logger = createLogger({ stream, level: "info" });
    logger.info("hello");
    expect(lines.length).toBe(1);
  });

  it("T-LOG-005: output is valid JSON (JSON Lines)", () => {
    const { stream, lines } = createMemoryStream();
    const logger = createLogger({ stream, level: "info" });
    logger.info("line 1");
    logger.warn("line 2");
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

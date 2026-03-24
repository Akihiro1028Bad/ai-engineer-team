import pino from "pino";
import type { DestinationStream } from "pino";

interface LoggerOptions {
  level?: string;
  stream?: DestinationStream;
}

export function createLogger(options?: LoggerOptions): pino.Logger {
  const level = options?.level ?? process.env["LOG_LEVEL"] ?? "info";

  if (options?.stream) {
    return pino({ level }, options.stream);
  }

  return pino({ level });
}

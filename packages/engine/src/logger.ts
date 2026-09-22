import type { Redactor } from "./security/redact.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  redactor?: Redactor;
  /** Where JSON lines go. Default: stderr, so stdout carries only the verdict JSON. */
  write?: (line: string) => void;
  level?: LogLevel;
  base?: Record<string, unknown>;
}

/** Structured JSON-lines logger. Every line passes through the redactor before it's written. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const min = ORDER[options.level ?? "info"];
  const base = options.base ?? {};

  const emit = (level: LogLevel, event: string, fields: Record<string, unknown> = {}): void => {
    if (ORDER[level] < min) return;
    let line: string;
    try {
      line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...base, ...fields });
    } catch {
      line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...base, note: "unserializable fields" });
    }
    write(options.redactor ? options.redactor.redact(line) : line);
  };

  return {
    debug: (e, f) => emit("debug", e, f),
    info: (e, f) => emit("info", e, f),
    warn: (e, f) => emit("warn", e, f),
    error: (e, f) => emit("error", e, f),
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  };
}

export const silentLogger: Logger = createLogger({ write: () => {} });

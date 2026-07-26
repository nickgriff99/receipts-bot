/**
 * Minimal structured logger. Deliberately dependency-free (no pino/winston)
 * to keep the dependency list matching the brief exactly — swap the
 * implementation later if Merry/ops want log shipping, the call sites
 * (`logger.info(...)` etc.) won't need to change.
 *
 * Every line is a single JSON object on stdout/stderr so it's grep-able and
 * ingestible by any log pipeline without extra parsing config.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function currentThreshold(): number {
  const configured = (process.env.LOG_LEVEL as LogLevel) || "info";
  return LEVEL_ORDER[configured] ?? LEVEL_ORDER.info;
}

function write(level: LogLevel, msg: string, fields?: LogFields): void {
  if (LEVEL_ORDER[level] < currentThreshold()) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  const stream = level === "error" || level === "warn" ? console.error : console.log;
  stream(JSON.stringify(line));
}

export const logger = {
  debug: (msg: string, fields?: LogFields) => write("debug", msg, fields),
  info: (msg: string, fields?: LogFields) => write("info", msg, fields),
  warn: (msg: string, fields?: LogFields) => write("warn", msg, fields),
  error: (msg: string, fields?: LogFields) => write("error", msg, fields),
  /** Scope a logger to a module so every line carries a `module` tag. */
  child(moduleName: string) {
    return {
      debug: (msg: string, fields?: LogFields) => write("debug", msg, { module: moduleName, ...fields }),
      info: (msg: string, fields?: LogFields) => write("info", msg, { module: moduleName, ...fields }),
      warn: (msg: string, fields?: LogFields) => write("warn", msg, { module: moduleName, ...fields }),
      error: (msg: string, fields?: LogFields) => write("error", msg, { module: moduleName, ...fields }),
    };
  },
};

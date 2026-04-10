type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

function formatLog(
  level: LogLevel,
  component: string,
  message: string,
  data?: Record<string, unknown>
): string {
  const timestamp = new Date().toISOString();
  const base = `${timestamp} [${level.toUpperCase()}] [${component}] ${message}`;
  if (data && Object.keys(data).length > 0) {
    return `${base} ${JSON.stringify(data)}`;
  }
  return base;
}

export function createLogger(component: string) {
  return {
    debug(message: string, data?: Record<string, unknown>) {
      if (shouldLog("debug")) console.debug(formatLog("debug", component, message, data));
    },
    info(message: string, data?: Record<string, unknown>) {
      if (shouldLog("info")) console.info(formatLog("info", component, message, data));
    },
    warn(message: string, data?: Record<string, unknown>) {
      if (shouldLog("warn")) console.warn(formatLog("warn", component, message, data));
    },
    error(message: string, data?: Record<string, unknown>) {
      if (shouldLog("error")) console.error(formatLog("error", component, message, data));
    },
  };
}

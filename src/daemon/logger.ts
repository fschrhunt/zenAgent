export const DAEMON_LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type DaemonLogLevel = (typeof DAEMON_LOG_LEVELS)[number];

export interface DaemonLogEntry {
  readonly timestamp: string;
  readonly level: DaemonLogLevel;
  readonly component: "daemon" | "socket" | "transport";
  readonly event: string;
  readonly clientId?: string;
  readonly operationId?: string;
  readonly data?: Readonly<Record<string, string | number | boolean | null>>;
}

export type DaemonLogSink = (entry: DaemonLogEntry) => void;

export interface DaemonLogger {
  log(
    level: DaemonLogLevel,
    component: DaemonLogEntry["component"],
    event: string,
    context?: Readonly<{
      clientId?: string;
      operationId?: string;
      data?: Readonly<Record<string, string | number | boolean | null>>;
    }>,
  ): void;
}

const LEVEL_PRIORITY: Readonly<Record<DaemonLogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function createDaemonLogger(options?: {
  readonly level?: DaemonLogLevel;
  readonly sink?: DaemonLogSink;
  readonly now?: () => string;
}): DaemonLogger {
  const minimum = options?.level ?? "info";
  const sink = options?.sink ?? (() => undefined);
  const now = options?.now ?? (() => new Date().toISOString());

  return {
    log(level, component, event, context): void {
      if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minimum]) {
        return;
      }

      // The API accepts only explicitly structured scalar fields. Callers
      // cannot accidentally pass request params, browser entities, or errors.
      sink({
        timestamp: now(),
        level,
        component,
        event,
        ...(context?.clientId === undefined
          ? {}
          : { clientId: context.clientId }),
        ...(context?.operationId === undefined
          ? {}
          : { operationId: context.operationId }),
        ...(context?.data === undefined ? {} : { data: context.data }),
      });
    },
  };
}

export const silentDaemonLogger = createDaemonLogger();

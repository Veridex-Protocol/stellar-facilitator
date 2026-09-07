/**
 * Veridex Facilitator Service - Structured Logging
 * License: Apache-2.0
 *
 * One structured line per request, carrying the outcome and the latency. This
 * is what published reliability numbers have to be derived from: the in-memory
 * counters on `/stats` reset on every restart, so they can back a dashboard but
 * never a claim.
 *
 * Lines are JSON on stdout, one per line, so `docker compose logs facilitator |
 * jq` and `scripts/summarize-outcomes.mjs` both work without a log shipper.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface RequestOutcome {
  endpoint: string;
  /** What happened, in the vocabulary of the endpoint. */
  outcome: "valid" | "invalid" | "settled" | "failed" | "ok" | "error" | "rate_limited";
  status: number;
  latencyMs: number;
  reason?: string;
  requestId?: string;
  paymentId?: string;
  resource?: string;
  payer?: string;
  transaction?: string;
  transactionHash?: string;
  /** Set when the ledger-skew retry fired, so recovery rate is measurable. */
  skewRetries?: number;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  outcome(outcome: RequestOutcome): void;
}

/**
 * Creates a JSON-lines logger.
 *
 * @param options - Minimum level and the service name stamped on every line
 * @returns A logger
 */
export function createLogger(options: { level?: LogLevel; service?: string } = {}): Logger {
  const minimum = LEVEL_ORDER[options.level ?? (process.env.LOG_LEVEL as LogLevel) ?? "info"] ?? 20;
  const service = options.service ?? "facilitator";

  /**
   * Writes one line if the level passes the threshold.
   *
   * @param level - Severity
   * @param message - Human-readable summary
   * @param fields - Structured context
   */
  function write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < minimum) return;
    const line = { time: new Date().toISOString(), level, service, message, ...fields };
    const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
    stream.write(`${JSON.stringify(line)}\n`);
  }

  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
    outcome: (outcome) =>
      write("info", `${outcome.endpoint} ${outcome.outcome}`, { ...outcome, kind: "request_outcome" }),
  };
}

import type { LoggerService, LogLevel as NestLogLevel } from "@nestjs/common";

import type { LogLevel } from "@avni/config";

const SEVERITY: Record<LogLevel, number> = {
  fatal: 60,
  error: 50,
  warn: 40,
  info: 30,
  debug: 20,
  trace: 10,
};

export interface StdoutLoggerOptions {
  readonly service: string;
  readonly level: LogLevel;
  /** Injectable so a test can read what was written without capturing a stream. */
  readonly write?: (line: string) => void;
}

interface LogRecord {
  readonly time: string;
  readonly level: LogLevel;
  readonly service: string;
  readonly context?: string;
  readonly message: unknown;
  readonly stack?: string;
}

/**
 * Operational logs to stdout, one JSON object per line, because the container
 * runtime is the log shipper and nothing on the Bank's VM is going to parse a
 * format we invented.
 *
 * Anything load-bearing does not come here. Enrollment's failure cause, the
 * Mandate lifecycle and every Dashboard read go to the audit table instead — a
 * table the Dashboard reads is reachable from a deployment we do not operate,
 * and a file on a box is not.
 */
export class StdoutLogger implements LoggerService {
  private readonly threshold: number;
  private readonly write: (line: string) => void;

  public constructor(private readonly options: StdoutLoggerOptions) {
    this.threshold = SEVERITY[options.level];
    this.write = options.write ?? ((line) => process.stdout.write(line));
  }

  public log(message: unknown, context?: string): void {
    this.emit("info", message, context);
  }

  public warn(message: unknown, context?: string): void {
    this.emit("warn", message, context);
  }

  public debug(message: unknown, context?: string): void {
    this.emit("debug", message, context);
  }

  public verbose(message: unknown, context?: string): void {
    this.emit("trace", message, context);
  }

  public fatal(message: unknown, context?: string): void {
    this.emit("fatal", message, context);
  }

  public error(message: unknown, stack?: string, context?: string): void {
    this.emit("error", message, context, stack);
  }

  public setLogLevels?(_levels: NestLogLevel[]): void {
    // The level is configuration, read once at boot. Nest may not change it.
  }

  private emit(level: LogLevel, message: unknown, context?: string, stack?: string): void {
    if (SEVERITY[level] < this.threshold) return;

    const record: LogRecord = {
      time: new Date().toISOString(),
      level,
      service: this.options.service,
      ...(context === undefined ? {} : { context }),
      message: message instanceof Error ? message.message : message,
      ...(stack === undefined ? {} : { stack }),
    };
    this.write(`${JSON.stringify(record)}\n`);
  }
}

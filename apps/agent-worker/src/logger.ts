import pino from "pino";

/**
 * The minimal structured-logger surface the worker depends on. `pino.Logger`
 * satisfies it; tests pass a no-op. Keeping it narrow means worker code is not
 * coupled to pino-specific APIs.
 */
export interface WorkerLogger {
	info(obj: Record<string, unknown>): void;
	warn(obj: Record<string, unknown>): void;
	error(obj: Record<string, unknown>): void;
}

/** Structured JSON logger for the worker process. */
export function createLogger(level: string): WorkerLogger {
	return pino({ level });
}

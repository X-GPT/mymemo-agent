import pino from "pino";

export interface WorkerLogger {
	info(obj: Record<string, unknown>): void;
	warn(obj: Record<string, unknown>): void;
	error(obj: Record<string, unknown>): void;
}

export function createLogger(level: string): WorkerLogger {
	return pino({ level });
}

export function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

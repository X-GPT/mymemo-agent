import pino from "pino";

export interface RuntimeLogger {
	info(obj: Record<string, unknown>): void;
	warn(obj: Record<string, unknown>): void;
	error(obj: Record<string, unknown>): void;
}

export function createLogger(level: string): RuntimeLogger {
	return pino({ level });
}

export function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

import pino from "pino";

export interface PublisherLogger {
	info(record: Record<string, unknown>): void;
	error(record: Record<string, unknown>): void;
}

export function createLogger(level: string): PublisherLogger {
	return pino({ level });
}

export function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

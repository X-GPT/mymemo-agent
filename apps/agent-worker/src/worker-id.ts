import { hostname } from "node:os";

/**
 * Per-process worker identity used as the run `locked_by` fence. Stable for the
 * process's lifetime and unique across replicas and restarts, so a crashed
 * worker's claims expire and are recovered rather than mistaken for a live
 * owner's. Mirrors chat-api's lease owner-id shape.
 */
export function generateWorkerId(): string {
	return `${hostname()}:${process.pid}:${crypto.randomUUID()}`;
}

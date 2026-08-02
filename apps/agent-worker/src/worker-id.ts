import { hostname } from "node:os";

/**
 * Per-process worker identity used for Claim correlation and Run execution
 * provenance. The Conversation Ownership epoch, not this identity, fences
 * writes because one process may Claim the same Conversation more than once.
 */
export function generateWorkerId(): string {
	return `${hostname()}:${process.pid}:${crypto.randomUUID()}`;
}

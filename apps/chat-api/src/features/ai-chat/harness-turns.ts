/**
 * Conversation ids with a Harness turn in flight. Checked and set in one
 * synchronous step by the chat route so two turns can never share a sandbox,
 * and consulted by Run admission so a Run and a Harness turn never drive one
 * Workspace; released only after `session.stop()` settles. In-process by
 * design for the single-process local composition.
 * ponytail: process-local set; a leased marker on conversation_runtime once
 * chat-api runs more than one process.
 */
export const activeHarnessTurns = new Set<string>();

/**
 * Identifies one run's executor work. Carries no secrets by construction — only
 * the binding the sandbox is allowed to know about.
 */
export interface RunBinding {
	userId: string;
	conversationId: string;
	runId: string;
	sandboxId: string;
}

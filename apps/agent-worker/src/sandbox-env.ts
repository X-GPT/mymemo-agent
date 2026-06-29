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

/**
 * Build the environment placed on an E2B sandbox for a run. By design this
 * accepts ONLY the run binding — never the worker config — so no provider key,
 * KB credential, or E2B key can structurally reach the untrusted sandbox. The
 * sandbox gets per-run executor metadata that cannot grant provider or document
 * access (split-runtime credential model).
 */
export function buildSandboxEnv(binding: RunBinding): Record<string, string> {
	return {
		MYMEMO_USER_ID: binding.userId,
		MYMEMO_CONVERSATION_ID: binding.conversationId,
		MYMEMO_RUN_ID: binding.runId,
		MYMEMO_SANDBOX_ID: binding.sandboxId,
		MYMEMO_RUNTIME: "split-fargate-e2b",
	};
}

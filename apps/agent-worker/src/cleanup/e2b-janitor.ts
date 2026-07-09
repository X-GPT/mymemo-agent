import { Sandbox } from "e2b";
import type { SandboxJanitor } from "./cleanup";

/**
 * The concrete {@link SandboxJanitor} over the real E2B SDK — the worker's only
 * live E2B access for cleanup, injected at the entrypoint so the cleanup logic
 * stays unit-testable against a fake (see cleanup.test.ts). The static kill
 * returns `false` (it does not throw) when the sandbox is already gone, so a
 * not-found reconciles as success; only a real transport/auth failure rejects,
 * which the sweeps catch and leave for the next pass to retry.
 */
export function createE2bSandboxJanitor(apiKey: string): SandboxJanitor {
	const opts = { apiKey };
	return {
		async killSandbox(sandboxId: string): Promise<void> {
			await Sandbox.kill(sandboxId, opts);
		},
	};
}

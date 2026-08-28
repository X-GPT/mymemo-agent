import { Sandbox } from "e2b";
import type { HarnessConfig } from "@/config/harness-env";
import type { ConversationRef } from "@/features/conversation-store/conversation-store";

/** The E2B handle a Harness turn's tools run against; widens as the tools land. */
export type HarnessWorkspaceSandbox = Pick<Sandbox, "sandboxId">;

/** The slice of the `e2b` SDK the attacher uses; tests inject a fake. */
export interface E2bSandboxFactory {
	connect(
		sandboxId: string,
		options: { apiKey: string; timeoutMs: number },
	): Promise<HarnessWorkspaceSandbox>;
	create(
		template: string,
		options: {
			apiKey: string;
			timeoutMs: number;
			lifecycle: { onTimeout: "pause" };
			metadata: { userId: string; conversationId: string };
		},
	): Promise<HarnessWorkspaceSandbox>;
}

/**
 * Attach one Harness turn to the Conversation's Workspace given its current
 * pointer; the caller records the returned `sandboxId`, which differs from the
 * one passed when a fresh sandbox was created.
 */
export type AttachHarnessWorkspace = (
	input: ConversationRef & { sandboxId: string | null },
) => Promise<HarnessWorkspaceSandbox>;

const e2bSandboxFactory: E2bSandboxFactory = {
	connect: (sandboxId, options) => Sandbox.connect(sandboxId, options),
	create: (template, options) => Sandbox.create(template, options),
};

/**
 * Connect-or-create against the Conversation's existing E2B Workspace without
 * a Run (ADR-0033 stage 2): pointer set → connect (auto-resumes a paused
 * sandbox); unset or connect fails → a fresh sandbox from the pinned template,
 * attributed by metadata. The idle window is granted once here as
 * `HARNESS_SANDBOX_TIMEOUT_MS` — no renewal timer, no taint, no orphan
 * ledger, no Ownership fence; a sandbox created but never recorded
 * idle-pauses on its own.
 */
export function createHarnessWorkspaceAttacher(
	{
		E2B_API_KEY: apiKey,
		WORKER_E2B_TEMPLATE: template,
		HARNESS_SANDBOX_TIMEOUT_MS: timeoutMs,
	}: Pick<
		HarnessConfig,
		"E2B_API_KEY" | "WORKER_E2B_TEMPLATE" | "HARNESS_SANDBOX_TIMEOUT_MS"
	>,
	logger: { warn(obj: object, msg: string): void },
	factory: E2bSandboxFactory = e2bSandboxFactory,
): AttachHarnessWorkspace {
	return async ({ userId, conversationId, sandboxId }) => {
		if (sandboxId !== null) {
			try {
				return await factory.connect(sandboxId, { apiKey, timeoutMs });
			} catch (error) {
				logger.warn(
					{ err: error, conversationId, sandboxId },
					"harness workspace connect failed; creating a fresh sandbox",
				);
			}
		}
		return factory.create(template, {
			apiKey,
			timeoutMs,
			lifecycle: { onTimeout: "pause" },
			metadata: { userId, conversationId },
		});
	};
}

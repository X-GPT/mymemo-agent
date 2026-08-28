import { Sandbox } from "e2b";
import type { HarnessConfig } from "@/config/harness-env";
import type { ConversationRef } from "@/features/conversation-store/conversation-store";

/** The E2B handle a Harness turn's tools run against; widens as the tools land. */
export interface HarnessWorkspaceSandbox {
	readonly sandboxId: string;
}

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

export interface HarnessWorkspace {
	sandbox: HarnessWorkspaceSandbox;
	/** `true` when a fresh sandbox was created — the pointer was unset or
	 * connecting failed — so the caller must repoint the Conversation. */
	isNew: boolean;
}

/** Attach one Harness turn to the Conversation's Workspace given its current pointer. */
export type AttachHarnessWorkspace = (
	input: ConversationRef & { sandboxId: string | null },
) => Promise<HarnessWorkspace>;

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
	config: Pick<
		HarnessConfig,
		"E2B_API_KEY" | "WORKER_E2B_TEMPLATE" | "HARNESS_SANDBOX_TIMEOUT_MS"
	>,
	logger: { warn(obj: object, msg: string): void },
	factory: E2bSandboxFactory = e2bSandboxFactory,
): AttachHarnessWorkspace {
	const apiKey = config.E2B_API_KEY;
	const timeoutMs = config.HARNESS_SANDBOX_TIMEOUT_MS;
	return async ({ userId, conversationId, sandboxId }) => {
		if (sandboxId !== null) {
			try {
				const sandbox = await factory.connect(sandboxId, { apiKey, timeoutMs });
				return { sandbox, isNew: false };
			} catch (error) {
				logger.warn(
					{ err: error, conversationId, sandboxId },
					"harness workspace connect failed; creating a fresh sandbox",
				);
			}
		}
		const sandbox = await factory.create(config.WORKER_E2B_TEMPLATE, {
			apiKey,
			timeoutMs,
			lifecycle: { onTimeout: "pause" },
			metadata: { userId, conversationId },
		});
		return { sandbox, isNew: true };
	};
}

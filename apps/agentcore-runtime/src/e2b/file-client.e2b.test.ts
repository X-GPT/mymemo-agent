// Live E2B test (Task 9.4 acceptance): proves the production E2BFileClient
// against a real sandbox provisioned from the custom template (Task 9.2),
// which ships the `rg` the Grep tool and Bash file discovery use — the stock
// `base` template lacks rg. Skipped unless E2B_API_KEY is set; run locally
// with `E2B_API_KEY=... bun test file-client.e2b` (WORKER_E2B_TEMPLATE
// overrides the default template alias, as in template:verify).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Sandbox } from "e2b";
import { TEMPLATE_NAME } from "../../e2b-template/template";
import type { FileToolLimits } from "../file-tools/file-tools";
import { runReadFileTool, runWriteFileTool } from "../file-tools/file-tools";
import { parseToolResult, runFileToolsContract } from "../file-tools/testing";
import type { RuntimeLogger } from "../logger";
import {
	createE2bSandboxProvisioner,
	type ProvisionedSandbox,
} from "./sandbox-provisioner";

const API_KEY = process.env.E2B_API_KEY;
const TEMPLATE = process.env.WORKER_E2B_TEMPLATE ?? TEMPLATE_NAME;
const LIVE = !!API_KEY;
const TEST_TIMEOUT_MS = 180_000;

const noopLogger: RuntimeLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
};

const limits: FileToolLimits = {
	readMaxBytes: 1024,
	readMaxLines: 200,
	grepMaxResults: 100,
	commandMaxOutputBytes: 16_384,
	commandTimeoutMs: 10_000,
};

describe.skipIf(!LIVE)("E2BFileClient against live E2B", () => {
	let provisioned: ProvisionedSandbox;

	beforeAll(async () => {
		const provisioner = createE2bSandboxProvisioner({
			// biome-ignore lint/style/noNonNullAssertion: skipIf(!LIVE) guarantees it is set
			apiKey: API_KEY!,
			template: TEMPLATE,
			sandboxIdleMs: 120_000,
			logger: noopLogger,
		});
		provisioned = await provisioner.provisionForRun({
			userId: "user-live",
			conversationId: "conv-live",
			sandboxId: null,
			sandboxTainted: false,
		});
		expect(provisioned.isNew).toBe(true);
	});

	afterAll(async () => {
		if (provisioned) {
			provisioned.dispose();
			// dispose() never kills by design; the test must not leak a paused
			// sandbox, so kill it directly.
			await Sandbox.kill(provisioned.sandboxId, { apiKey: API_KEY }).catch(
				() => {},
			);
		}
	});

	it(
		"passes the file-tools integration contract (rg-backed Grep)",
		async () => {
			await runFileToolsContract({
				client: provisioned.fileClient,
				// A dedicated subdirectory so template home-directory files cannot
				// leak into the contract's exact-match expectations.
				workspaceRoot: `${provisioned.workspaceRoot}/file-tools-contract`,
				limits,
			});
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"round-trips a write and read through the file tools and renews the sandbox",
		async () => {
			const context = {
				client: provisioned.fileClient,
				workspaceRoot: provisioned.workspaceRoot,
				limits,
			};
			const content = "line one\nline two\n";

			const writeResult = await runWriteFileTool(
				{ path: "notes/roundtrip.txt", content },
				context,
			);
			expect(writeResult.isError).toBeUndefined();

			const readResult = await runReadFileTool(
				{ path: "notes/roundtrip.txt" },
				context,
			);
			expect(readResult.isError).toBeUndefined();
			expect(parseToolResult(readResult)).toMatchObject({
				path: "notes/roundtrip.txt",
				content,
				truncated: false,
			});

			// The keep-alive path against the real API: extending the idle window
			// must succeed while the sandbox is live.
			await provisioned.renew();
		},
		TEST_TIMEOUT_MS,
	);
});

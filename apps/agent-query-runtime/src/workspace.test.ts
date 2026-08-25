import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
	conversationRuntime,
	conversations,
	orphanSandboxes,
} from "@mymemo/agent-db/schema";
import { createTestDatabase, type TestDb } from "@mymemo/agent-db/testing";
import type {
	ProvisionedSandbox,
	ProvisionForRunInput,
} from "../../agentcore-runtime/src/e2b/sandbox-provisioner";
import {
	DEFAULT_FILE_TOOL_LIMITS,
	runReadFileTool,
	runWriteFileTool,
	type SandboxFileClient,
} from "../../agentcore-runtime/src/file-tools/file-tools";
import {
	AGENTCORE_RUNTIME_SESSION_HEADER,
	createAgentQueryRequestHandler,
} from "./server";
import { createAgentQuerySessionStore } from "./session-store";
import { createAgentQueryWorkspacePreparer } from "./workspace";

describe("Agent-query Workspace continuity", () => {
	let tdb: TestDb;

	beforeAll(async () => {
		tdb = await createTestDatabase();
	});

	afterAll(async () => {
		await tdb.close();
	});

	beforeEach(async () => {
		await tdb.db.delete(orphanSandboxes);
		await tdb.db.delete(conversationRuntime);
		await tdb.db.delete(conversations);
		await tdb.db.insert(conversations).values({
			userId: "member-1",
			conversationId: "conversation-1",
			scope: "general",
			epoch: 7,
			ownerUntil: new Date(Date.now() + 60_000),
		});
	});

	it("renews work and preserves a tool-written partial file after response failure", async () => {
		const provisions: ProvisionForRunInput[] = [];
		const filesBySandbox = new Map<string, Map<string, string>>();
		let activeFileClient: SandboxFileClient | undefined;
		let renewals = 0;
		const provisioner = {
			async provisionForRun(input: ProvisionForRunInput) {
				provisions.push(input);
				const sandboxId = input.sandboxId ?? "sandbox-1";
				const files =
					filesBySandbox.get(sandboxId) ?? new Map<string, string>();
				filesBySandbox.set(sandboxId, files);
				activeFileClient = {
					async readFile({ path }) {
						const content = files.get(path);
						if (content === undefined) throw new Error("file not found");
						return content;
					},
					async writeFile({ path, content }) {
						files.set(path, content);
					},
					async runCommand() {
						return { exitCode: 0, stdout: "", stderr: "", truncated: false };
					},
				};
				return {
					sandboxId,
					isNew: input.sandboxId === null,
					workspaceRoot: "/home/user",
					fileClient: activeFileClient,
					commandClient: {},
					artifactWorkspace: {},
					async renew() {
						renewals++;
					},
					dispose() {},
				} as ProvisionedSandbox;
			},
		};
		const prepareWorkspace = createAgentQueryWorkspacePreparer({
			db: tdb.db,
			provisioner,
			sandboxIdleMs: 2,
			logger: { warn() {} },
		});
		const response = await createAgentQueryRequestHandler({
			query() {
				const stream = (async function* () {
					yield { type: "system", subtype: "init" } as SDKMessage;
					await Bun.sleep(10);
					if (!activeFileClient) {
						throw new Error("Workspace file client missing");
					}
					await runWriteFileTool(
						{ path: "draft.md", content: "partial work" },
						{
							client: activeFileClient,
							workspaceRoot: "/home/user",
							limits: DEFAULT_FILE_TOOL_LIMITS,
						},
					);
					throw new Error("response failed");
				})();
				return Object.assign(stream, { async interrupt() {} });
			},
			createSessionStore: (conversation) =>
				createAgentQuerySessionStore(tdb.db, conversation),
			async prepareWorkingDirectory() {},
			prepareWorkspace,
			async verifyResponseAuthority() {
				return new Date(Date.now() + 60_000);
			},
		})(
			new Request("http://runtime/invocations", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					[AGENTCORE_RUNTIME_SESSION_HEADER]: "conversation-1",
				},
				body: JSON.stringify({
					version: 1,
					conversationId: "conversation-1",
					conversationEpoch: 7,
					prompt: "write a draft",
					model: "anthropic/claude-sonnet-5",
				}),
			}),
		);
		await expect(response.text()).rejects.toThrow("response failed");

		const second = await prepareWorkspace({
			conversationId: "conversation-1",
			conversationEpoch: 7,
		});
		if (!activeFileClient) throw new Error("Workspace file client missing");
		const read = await runReadFileTool(
			{ path: "draft.md" },
			{
				client: activeFileClient,
				workspaceRoot: "/home/user",
				limits: DEFAULT_FILE_TOOL_LIMITS,
			},
		);

		expect(provisions).toEqual([
			{
				userId: "member-1",
				conversationId: "conversation-1",
				sandboxId: null,
				sandboxTainted: false,
			},
			{
				userId: "member-1",
				conversationId: "conversation-1",
				sandboxId: "sandbox-1",
				sandboxTainted: false,
			},
		]);
		expect(read.content[0]?.text).toContain("partial work");
		expect(renewals).toBeGreaterThan(0);
		expect(
			(await tdb.db.select().from(conversationRuntime))[0]?.sandboxId,
		).toBe("sandbox-1");
		expect(second.queryOptions.allowedTools).toContain(
			"mcp__mymemo-executor__Write",
		);
		expect(second.queryOptions.allowedTools).not.toContain(
			"mcp__mymemo-executor__Bash",
		);
		await second.stop();
		expect(second.signal.aborted).toBe(true);
		second.dispose();
	});

	it("records the prior Workspace when a fresh sandbox replaces it", async () => {
		await tdb.db.insert(conversationRuntime).values({
			userId: "member-1",
			conversationId: "conversation-1",
			sandboxId: "sandbox-old",
			sandboxTainted: true,
		});
		const workspace = await createAgentQueryWorkspacePreparer({
			db: tdb.db,
			provisioner: {
				async provisionForRun() {
					return {
						sandboxId: "sandbox-new",
						isNew: true,
						workspaceRoot: "/home/user",
						fileClient: {},
						commandClient: {},
						artifactWorkspace: {},
						async renew() {},
						dispose() {},
					} as ProvisionedSandbox;
				},
			},
			sandboxIdleMs: 300_000,
			logger: { warn() {} },
		})({ conversationId: "conversation-1", conversationEpoch: 7 });

		expect(await tdb.db.select().from(orphanSandboxes)).toEqual([
			expect.objectContaining({
				sandboxId: "sandbox-old",
				runId: "agent-query",
				reason: "tainted Agent-query Workspace replaced",
			}),
		]);
		workspace.dispose();
	});

	it("records a fresh Workspace when publication fails", async () => {
		await tdb.db.update(conversations).set({ epoch: 8 });
		const prepareWorkspace = createAgentQueryWorkspacePreparer({
			db: tdb.db,
			provisioner: {
				async provisionForRun() {
					return {
						sandboxId: "sandbox-new",
						isNew: true,
						workspaceRoot: "/home/user",
						fileClient: {},
						commandClient: {},
						artifactWorkspace: {},
						async renew() {},
						dispose() {},
					} as ProvisionedSandbox;
				},
			},
			sandboxIdleMs: 300_000,
			logger: { warn() {} },
		});

		await expect(
			prepareWorkspace({
				conversationId: "conversation-1",
				conversationEpoch: 7,
			}),
		).rejects.toThrow("response authority");
		expect(await tdb.db.select().from(orphanSandboxes)).toEqual([
			expect.objectContaining({
				sandboxId: "sandbox-new",
				runId: "agent-query",
				reason: "Agent-query Workspace publication failed",
			}),
		]);
	});
});

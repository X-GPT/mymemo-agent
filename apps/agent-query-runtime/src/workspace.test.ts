import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { conversationRuntime, conversations } from "@mymemo/agent-db/schema";
import { createTestDatabase, type TestDb } from "@mymemo/agent-db/testing";
import type {
	ProvisionedSandbox,
	ProvisionForRunInput,
} from "../../agentcore-runtime/src/e2b/sandbox-provisioner";
import { createDirectResponseWorkspacePreparer } from "./workspace";

describe("direct-response Workspace continuity", () => {
	let tdb: TestDb;

	beforeAll(async () => {
		tdb = await createTestDatabase();
	});

	afterAll(async () => {
		await tdb.close();
	});

	beforeEach(async () => {
		await tdb.db.delete(conversationRuntime);
		await tdb.db.delete(conversations);
		await tdb.db.insert(conversations).values({
			userId: "member-1",
			conversationId: "conversation-1",
			scope: "general",
			epoch: 7,
		});
	});

	it("reuses the persisted E2B Workspace across sequential responses", async () => {
		const provisions: ProvisionForRunInput[] = [];
		const workspaceFiles = new Map<string, string>();
		const provisioner = {
			async provisionForRun(input: ProvisionForRunInput) {
				provisions.push(input);
				const sandboxId = input.sandboxId ?? "sandbox-1";
				return {
					sandboxId,
					isNew: input.sandboxId === null,
					workspaceRoot: "/home/user",
					fileClient: {},
					commandClient: {},
					artifactWorkspace: {},
					async renew() {},
					dispose() {},
				} as ProvisionedSandbox;
			},
		};
		const prepareWorkspace = createDirectResponseWorkspacePreparer({
			db: tdb.db,
			provisioner,
			logger: { info() {}, warn() {} },
		});

		const first = await prepareWorkspace({
			conversationId: "conversation-1",
			conversationEpoch: 7,
		});
		workspaceFiles.set("draft.md", "partial work");
		await first.stop();
		first.dispose();
		const second = await prepareWorkspace({
			conversationId: "conversation-1",
			conversationEpoch: 7,
		});

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
		expect(workspaceFiles.get("draft.md")).toBe("partial work");
		expect(
			(await tdb.db.select().from(conversationRuntime))[0]?.sandboxId,
		).toBe("sandbox-1");
		expect(second.queryOptions.allowedTools).toContain(
			"mcp__mymemo-executor__Write",
		);
		second.dispose();
	});
});

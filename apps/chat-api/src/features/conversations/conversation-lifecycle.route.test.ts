import { describe, expect, it } from "bun:test";
import { createTestDatabase } from "@mymemo/agent-db/testing";
import type { ApiConfig } from "@/config/env";
import type { AppDeps } from "@/deps";
import type { ConversationStore } from "@/features/conversation-store/conversation-store";
import { PostgresConversationStore } from "@/features/conversation-store/postgres-conversation-store";
import type { ExposureGate } from "@/features/exposure-gate";
import type { InternalIdentity } from "./conversations.schema";

const { createApp } = await import("@/app");

// The /v2/conversations resource carries v1 semantics (#657): same handlers,
// mounted a second time. conversations.route.test.ts covers the shared
// handlers in depth; this file covers only what #657's acceptance criteria
// require of the v2 mount itself — frozen Scope for the three shapes,
// exposure-gated creation with gate bypass elsewhere, the Archive round-trip,
// v1 permanent deletion, and the absence of every other v1 route under /v2.

/** Gate that records the identity it saw and returns a fixed decision. */
function recordingGate(decision: boolean) {
	const seen: InternalIdentity[] = [];
	const gate: ExposureGate = {
		async isAgentEnabled(identity) {
			seen.push(identity);
			return decision;
		},
	};
	return { gate, seen };
}

function gateThatFailsIfConsulted(): ExposureGate {
	return {
		async isAgentEnabled() {
			throw new Error("exposure gate should not be consulted");
		},
	};
}

function buildApp(
	conversationStore: ConversationStore,
	exposureGate: ExposureGate = recordingGate(true).gate,
) {
	const deps = { conversationStore, exposureGate } as unknown as AppDeps;
	return createApp({ logLevel: "silent" } as unknown as ApiConfig, deps);
}

const identityHeaders = {
	"content-type": "application/json",
	"x-member-code": "member-1",
	"x-partner-code": "partner-1",
};

interface SummaryBody {
	conversationId: string;
	title: string | null;
	scope: string;
	createdAt: string;
	lastActivityAt: string;
	archivedAt: string | null;
}

async function createV2Conversation(
	app: ReturnType<typeof buildApp>,
	body: Record<string, unknown> = {},
): Promise<SummaryBody> {
	const res = await app.request("/v2/conversations", {
		method: "POST",
		headers: identityHeaders,
		body: JSON.stringify(body),
	});
	expect(res.status).toBe(201);
	return (await res.json()) as SummaryBody;
}

describe("POST /v2/conversations", () => {
	it("freezes the Scope at creation for all three shapes", async () => {
		const tdb = await createTestDatabase();
		try {
			const store = new PostgresConversationStore(tdb.db);
			const app = buildApp(store);

			const cases: [Record<string, unknown>, string][] = [
				[{}, "general"],
				[{ collectionId: "col-1" }, "collection"],
				[{ collectionId: "col-1", summaryId: "sum-1" }, "document"],
			];
			for (const [body, scope] of cases) {
				const created = await createV2Conversation(app, body);
				expect(created).toMatchObject({
					title: null,
					scope,
					archivedAt: null,
				});
				expect(
					await store.get({
						userId: "member-1",
						conversationId: created.conversationId,
					}),
				).toMatchObject({ scope });
			}
		} finally {
			await tdb.close();
		}
	});

	it("is exposure-gated on the trusted identity", async () => {
		const tdb = await createTestDatabase();
		try {
			const { gate, seen } = recordingGate(false);
			const app = buildApp(new PostgresConversationStore(tdb.db), gate);

			const res = await app.request("/v2/conversations", {
				method: "POST",
				headers: identityHeaders,
				body: JSON.stringify({}),
			});

			expect(res.status).toBe(403);
			expect(seen).toEqual([
				{ memberCode: "member-1", partnerCode: "partner-1" },
			]);
		} finally {
			await tdb.close();
		}
	});
});

describe("GET/PATCH/DELETE /v2/conversations", () => {
	it("round-trips Archive: partitioned out of the default list, then back", async () => {
		const tdb = await createTestDatabase();
		try {
			const store = new PostgresConversationStore(tdb.db);
			const createApp2 = buildApp(store);
			const { conversationId } = await createV2Conversation(createApp2);
			// Reads, renames, archives, and deletes bypass the exposure gate.
			const app = buildApp(store, gateThatFailsIfConsulted());

			const archive = await app.request(`/v2/conversations/${conversationId}`, {
				method: "PATCH",
				headers: identityHeaders,
				body: JSON.stringify({ archived: true }),
			});
			expect(archive.status).toBe(200);
			expect(((await archive.json()) as SummaryBody).archivedAt).not.toBeNull();

			const regular = await app.request("/v2/conversations", {
				headers: identityHeaders,
			});
			expect(
				((await regular.json()) as { conversations: SummaryBody[] })
					.conversations,
			).toHaveLength(0);
			const archived = await app.request("/v2/conversations?archived=true", {
				headers: identityHeaders,
			});
			expect(
				((await archived.json()) as { conversations: SummaryBody[] })
					.conversations,
			).toHaveLength(1);

			// An archived Conversation still accepts a rename.
			const rename = await app.request(`/v2/conversations/${conversationId}`, {
				method: "PATCH",
				headers: identityHeaders,
				body: JSON.stringify({ title: "renamed while archived" }),
			});
			expect(rename.status).toBe(200);

			const unarchive = await app.request(
				`/v2/conversations/${conversationId}`,
				{
					method: "PATCH",
					headers: identityHeaders,
					body: JSON.stringify({ archived: false }),
				},
			);
			expect(unarchive.status).toBe(200);
			const back = (await unarchive.json()) as SummaryBody;
			expect(back).toMatchObject({
				title: "renamed while archived",
				archivedAt: null,
			});
		} finally {
			await tdb.close();
		}
	});

	it("permanently deletes with v1 semantics and stays owner-scoped", async () => {
		const tdb = await createTestDatabase();
		try {
			const store = new PostgresConversationStore(tdb.db);
			const { conversationId } = await createV2Conversation(buildApp(store));
			const app = buildApp(store, gateThatFailsIfConsulted());

			const foreign = await app.request(`/v2/conversations/${conversationId}`, {
				method: "DELETE",
				headers: { ...identityHeaders, "x-member-code": "member-2" },
			});
			expect(foreign.status).toBe(404);

			const deleted = await app.request(`/v2/conversations/${conversationId}`, {
				method: "DELETE",
				headers: identityHeaders,
			});
			expect(deleted.status).toBe(204);
			expect(
				await store.get({ userId: "member-1", conversationId }),
			).toBeNull();

			const again = await app.request(`/v2/conversations/${conversationId}`, {
				method: "DELETE",
				headers: identityHeaders,
			});
			expect(again.status).toBe(404);
		} finally {
			await tdb.close();
		}
	});
});

describe("v2 surface boundaries", () => {
	it("does not mount the v1 Run routes under /v2", async () => {
		const tdb = await createTestDatabase();
		try {
			const store = new PostgresConversationStore(tdb.db);
			const { conversationId } = await createV2Conversation(buildApp(store));
			const app = buildApp(store, gateThatFailsIfConsulted());

			for (const [method, path] of [
				["POST", `/v2/conversations/${conversationId}/runs`],
				["GET", `/v2/conversations/${conversationId}/runs/run-1/events`],
				["POST", `/v2/conversations/${conversationId}/runs/run-1/interrupt`],
				["GET", `/v2/conversations/${conversationId}/history`],
				["GET", `/v2/conversations/${conversationId}/artifacts`],
			] as const) {
				const res = await app.request(path, {
					method,
					headers: identityHeaders,
					body: method === "POST" ? JSON.stringify({}) : undefined,
				});
				expect(res.status).toBe(404);
			}
		} finally {
			await tdb.close();
		}
	});

	it("serves the lifecycle routes identically under /v1", async () => {
		const tdb = await createTestDatabase();
		try {
			const store = new PostgresConversationStore(tdb.db);
			const app = buildApp(store);
			const res = await app.request("/v1/conversations", {
				method: "POST",
				headers: identityHeaders,
				body: JSON.stringify({ summaryId: "sum-1" }),
			});
			expect(res.status).toBe(201);
			const created = (await res.json()) as SummaryBody;
			expect(created.scope).toBe("document");

			const viaV2 = await app.request(
				`/v2/conversations/${created.conversationId}`,
				{
					method: "PATCH",
					headers: identityHeaders,
					body: JSON.stringify({ title: "one resource, two prefixes" }),
				},
			);
			expect(viaV2.status).toBe(200);
		} finally {
			await tdb.close();
		}
	});
});

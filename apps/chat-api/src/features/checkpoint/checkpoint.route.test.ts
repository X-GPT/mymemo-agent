import { beforeEach, describe, expect, it } from "bun:test";
import type { Readable } from "node:stream";
import { Hono } from "hono";
import type { ApiConfig } from "@/config/env";
import type { AppDeps, AppEnv } from "@/deps";
import type { ConversationVmStore } from "@/features/conversation-vm/conversation-vm-store";
import { mintGatewayToken } from "@/features/gateway/gateway-token";
import checkpointRoutes from "./checkpoint.route";
import type { CheckpointStore } from "./checkpoint-store";

const SECRET = "test-gateway-signing-secret";
const CONVERSATION_ID = "11111111-2222-4333-8444-555555555555";
const USER_ID = "member-1";
const VALID_TOKEN = await mintGatewayToken({
	conversationId: CONVERSATION_ID,
	userId: USER_ID,
	secret: SECRET,
});
const OTHER_TOKEN = await mintGatewayToken({
	conversationId: "99999999-2222-4333-8444-555555555555",
	userId: USER_ID,
	secret: SECRET,
});

const logged: { level: string; obj: Record<string, unknown>; msg: string }[] =
	[];
const logger = {
	info: (obj: Record<string, unknown>, msg: string) =>
		logged.push({ level: "info", obj, msg }),
	warn: (obj: Record<string, unknown>, msg: string) =>
		logged.push({ level: "warn", obj, msg }),
	error: (obj: Record<string, unknown>, msg: string) =>
		logged.push({ level: "error", obj, msg }),
};

/** An in-memory bucket. */
function fakeCheckpointStore() {
	const objects = new Map<string, Buffer>();
	const store: CheckpointStore = {
		async put(key, body: Readable, length) {
			const chunks: Buffer[] = [];
			for await (const chunk of body) chunks.push(chunk as Buffer);
			const bytes = Buffer.concat(chunks);
			if (bytes.byteLength !== length) {
				throw new Error(`length mismatch: ${bytes.byteLength} vs ${length}`);
			}
			objects.set(key, bytes);
		},
		async get(key) {
			const bytes = objects.get(key);
			if (!bytes) return null;
			return { body: new Blob([bytes]).stream(), length: bytes.byteLength };
		},
		async delete(key) {
			objects.delete(key);
		},
	};
	return { store, objects };
}

/** One `conversation_vm` row's pointer, guarded like the Postgres store. */
function fakeVmStore(row: { microvmId: string; pointer: string | null }) {
	const calls: unknown[] = [];
	const store = {
		async getCheckpointPointer(ref: unknown) {
			calls.push(["get", ref]);
			return row.pointer;
		},
		async swapCheckpointPointer(
			ref: unknown,
			options: { microvmId: string; key: string },
		) {
			calls.push(["swap", ref, options]);
			if (options.microvmId !== row.microvmId) return null;
			const previous = row.pointer;
			row.pointer = options.key;
			return { previous };
		},
	} as unknown as ConversationVmStore;
	return { store, calls, row };
}

function makeApp(deps: Partial<AppDeps>) {
	const app = new Hono<AppEnv>();
	app.use("*", async (c, next) => {
		c.set("deps", {
			config: { gatewayTokenSecret: SECRET } as ApiConfig,
			...deps,
		} as AppDeps);
		c.set("logger", logger as never);
		await next();
	});
	app.route("/v2/checkpoint", checkpointRoutes);
	return app;
}

function put(
	app: Hono<AppEnv>,
	body: Uint8Array,
	headers: Record<string, string> = {},
) {
	return app.request(`/v2/checkpoint/${CONVERSATION_ID}`, {
		method: "PUT",
		headers: {
			authorization: `Bearer ${VALID_TOKEN}`,
			"content-length": String(body.byteLength),
			"x-mymemo-microvm-id": "microvm-1",
			...headers,
		},
		body,
	});
}

beforeEach(() => {
	logged.length = 0;
});

describe("/v2/checkpoint (#670)", () => {
	const payload = Buffer.from("tarball-bytes");

	it("PUT streams the body to a fresh key under the Conversation's prefix, moves the pointer, and deletes the previous object", async () => {
		const bucket = fakeCheckpointStore();
		bucket.objects.set("conversations/x/old.tar.gz", Buffer.alloc(1));
		const vm = fakeVmStore({
			microvmId: "microvm-1",
			pointer: "conversations/x/old.tar.gz",
		});
		const app = makeApp({
			checkpointStore: bucket.store,
			conversationVmStore: vm.store,
		});

		const res = await put(app, payload);

		expect(res.status).toBe(204);
		expect(vm.row.pointer).toMatch(
			new RegExp(`^conversations/${CONVERSATION_ID}/[0-9a-f-]{36}\\.tar\\.gz$`),
		);
		expect(bucket.objects.size).toBe(1);
		expect(bucket.objects.get(vm.row.pointer ?? "")).toEqual(payload);
		// The row is addressed by the token's identity, never a header.
		expect(vm.calls[0]).toEqual([
			"swap",
			{ userId: USER_ID, conversationId: CONVERSATION_ID },
			{ microvmId: "microvm-1", key: vm.row.pointer },
		]);
		expect(logged.at(-1)).toMatchObject({
			msg: "checkpoint stored",
			obj: { bytes: payload.byteLength, key: vm.row.pointer },
		});
	});

	it("PUT from a VM the row no longer names is refused and its object removed", async () => {
		const bucket = fakeCheckpointStore();
		const vm = fakeVmStore({ microvmId: "microvm-2", pointer: "keep" });
		const app = makeApp({
			checkpointStore: bucket.store,
			conversationVmStore: vm.store,
		});

		const res = await put(app, payload);

		expect(res.status).toBe(409);
		expect(vm.row.pointer).toBe("keep");
		expect(bucket.objects.size).toBe(0);
	});

	it("PUT requires the VM id and a bounded Content-Length", async () => {
		const bucket = fakeCheckpointStore();
		const vm = fakeVmStore({ microvmId: "microvm-1", pointer: null });
		const app = makeApp({
			checkpointStore: bucket.store,
			conversationVmStore: vm.store,
		});

		expect(
			(await put(app, payload, { "x-mymemo-microvm-id": "" })).status,
		).toBe(400);
		expect((await put(app, payload, { "content-length": "" })).status).toBe(
			411,
		);
		expect(
			(await put(app, payload, { "content-length": String(2 ** 40) })).status,
		).toBe(413);
		expect(bucket.objects.size).toBe(0);
		expect(vm.row.pointer).toBeNull();
	});

	it("GET streams the object the pointer names, 204 with no pointer, 404 for a dangling one", async () => {
		const bucket = fakeCheckpointStore();
		bucket.objects.set(`conversations/${CONVERSATION_ID}/a.tar.gz`, payload);
		const vm = fakeVmStore({ microvmId: "microvm-1", pointer: null });
		const app = makeApp({
			checkpointStore: bucket.store,
			conversationVmStore: vm.store,
		});
		const get = () =>
			app.request(`/v2/checkpoint/${CONVERSATION_ID}`, {
				headers: { authorization: `Bearer ${VALID_TOKEN}` },
			});

		expect((await get()).status).toBe(204);

		vm.row.pointer = `conversations/${CONVERSATION_ID}/a.tar.gz`;
		const found = await get();
		expect(found.status).toBe(200);
		expect(found.headers.get("content-length")).toBe(
			String(payload.byteLength),
		);
		expect(Buffer.from(await found.arrayBuffer())).toEqual(payload);

		vm.row.pointer = "conversations/gone.tar.gz";
		expect((await get()).status).toBe(404);
	});

	it("rejects a missing, foreign, or malformed token with an opaque 401 before touching anything", async () => {
		const bucket = fakeCheckpointStore();
		const vm = fakeVmStore({ microvmId: "microvm-1", pointer: "x" });
		const app = makeApp({
			checkpointStore: bucket.store,
			conversationVmStore: vm.store,
		});
		for (const authorization of [
			undefined,
			`Bearer ${OTHER_TOKEN}`,
			"Bearer junk",
		]) {
			const res = await app.request(`/v2/checkpoint/${CONVERSATION_ID}`, {
				method: "PUT",
				headers: {
					...(authorization ? { authorization } : {}),
					"content-length": "1",
					"x-mymemo-microvm-id": "microvm-1",
				},
				body: new Uint8Array(1),
			});
			expect(res.status).toBe(401);
		}
		expect(vm.calls).toHaveLength(0);
		expect(bucket.objects.size).toBe(0);
	});

	it("answers 503 while MicroVM orchestration is not configured", async () => {
		const vm = fakeVmStore({ microvmId: "microvm-1", pointer: null });
		const app = makeApp({ conversationVmStore: vm.store });
		const res = await app.request(`/v2/checkpoint/${CONVERSATION_ID}`, {
			headers: { authorization: `Bearer ${VALID_TOKEN}` },
		});
		expect(res.status).toBe(503);
	});
});

import { Readable } from "node:stream";
import { type Context, Hono } from "hono";
import type { AppEnv } from "@/deps";
import { admitGatewayCaller } from "@/features/gateway/gateway.route";
import type { CheckpointStore } from "./checkpoint-store";

/**
 * The /v2 Checkpoint door (#670): a VM's Checkpoint in and out of S3 under
 * the gateway token — see "Checkpoint a v2 Conversation" in
 * docs/agents/chat-api.md and the ADR-0034 amendment.
 */

/**
 * Hard cap on one Checkpoint. The VM restores inside its 45 s transfer
 * budget (checkpoint.ts) and #670 quotes 1–16 MB/s per VM, so anything the
 * low end cannot move in that window would wedge every rehydrate of the
 * Conversation. ponytail: 32 MiB fits 1 MB/s; raise once the live bandwidth
 * is measured.
 */
const MAX_CHECKPOINT_BYTES = 32 * 1024 * 1024;

/** The verified caller: the Conversation its token names, and the store. */
async function admit(
	c: Context<AppEnv>,
): Promise<
	| { ref: { userId: string; conversationId: string }; store: CheckpointStore }
	| Response
> {
	const { config, checkpointStore } = c.var.deps;
	if (!config.gatewayTokenSecret || !checkpointStore) {
		return c.json({ error: "Checkpoint route is not configured" }, 503);
	}
	const conversationId = c.req.param("conversationId") ?? "";
	const admitted = await admitGatewayCaller(
		c,
		config.gatewayTokenSecret,
		conversationId,
	);
	if (admitted instanceof Response) return admitted;
	return {
		ref: { userId: admitted.userId, conversationId },
		store: checkpointStore,
	};
}

const routes = new Hono<AppEnv>();

routes.put("/:conversationId", async (c) => {
	const admitted = await admit(c);
	if (admitted instanceof Response) return admitted;
	const { ref, store } = admitted;
	const { deps, logger } = c.var;
	const microvmId = c.req.header("x-mymemo-microvm-id");
	if (!microvmId) return c.json({ error: "x-mymemo-microvm-id required" }, 400);
	const length = Number(c.req.header("content-length"));
	const body = c.req.raw.body;
	if (!Number.isSafeInteger(length) || length <= 0 || !body) {
		return c.json({ error: "Content-Length required" }, 411);
	}
	if (length > MAX_CHECKPOINT_BYTES) {
		return c.json({ error: "Checkpoint too large" }, 413);
	}

	const key = `conversations/${ref.conversationId}/${crypto.randomUUID()}.tar.gz`;
	await store.put(key, Readable.fromWeb(body as never), length);
	const swapped = await deps.conversationVmStore.swapCheckpointPointer(ref, {
		microvmId,
		key,
	});
	if (!swapped) {
		// A VM the row no longer names: its Checkpoint would fork the lineage.
		await store.delete(key).catch(() => {});
		logger.warn({ ...ref, microvmId }, "checkpoint from a retired VM refused");
		return c.json({ error: "VM is not this Conversation's" }, 409);
	}
	if (swapped.previous) {
		await store.delete(swapped.previous).catch((error: unknown) => {
			// An orphan under the prefix; permanent deletion sweeps the prefix.
			logger.warn(
				{ ...ref, key: swapped.previous, err: error },
				"previous checkpoint delete failed",
			);
		});
	}
	logger.info({ ...ref, microvmId, key, bytes: length }, "checkpoint stored");
	return c.body(null, 204);
});

routes.get("/:conversationId", async (c) => {
	const admitted = await admit(c);
	if (admitted instanceof Response) return admitted;
	const { ref, store } = admitted;
	const key = await c.var.deps.conversationVmStore.getCheckpointPointer(ref);
	if (!key) return c.body(null, 204);
	const object = await store.get(key);
	if (!object) {
		// The pointer names a missing object: the VM must fail its boot rather
		// than serve from nothing and fork the Conversation.
		c.var.logger.error({ ...ref, key }, "checkpoint pointer names no object");
		return c.json({ error: "Checkpoint object missing" }, 404);
	}
	return new Response(object.body, {
		headers: {
			"content-type": "application/gzip",
			"content-length": String(object.length),
		},
	});
});

export default routes;

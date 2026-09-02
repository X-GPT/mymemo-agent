import { type Context, Hono } from "hono";
import type { AppEnv } from "@/deps";
import { verifyGatewayToken } from "./gateway-token";

/**
 * The /v2 model gateway (ADR-0034, #659): the MicroVM's single door to the
 * model provider. Validates the per-Conversation token from the Authorization
 * header, injects the real OpenRouter credential, forwards the request
 * unbuffered in both directions, and logs per-Conversation usage — the
 * attribution feed token charging (#545) consumes. Auth is the signed token
 * alone: the caller is a VM, not the BFF, so `requireInternalIdentity` does
 * not apply here.
 */

/** Hop-by-hop or recomputed headers that must not be forwarded either way. */
const STRIPPED_HEADERS = [
	"host",
	"content-length",
	"content-encoding",
	"transfer-encoding",
	"connection",
];

/**
 * Watch the response stream for provider usage without buffering delivery.
 * Anthropic-shaped SSE carries usage on `message_start` (nested under
 * `message`) and cumulative totals on `message_delta`; non-streaming responses
 * carry one top-level `usage` object. Later values win, which matches the
 * cumulative semantics. Best-effort by design: a shape this scanner does not
 * recognize degrades to an attribution line without token counts, never to a
 * broken stream.
 */
function createUsageCollector(contentType: string | null) {
	const decoder = new TextDecoder();
	const found: { model?: string; usage?: Record<string, number> } = {};
	const isSse = contentType?.includes("text/event-stream") ?? false;
	const isJson = contentType?.includes("application/json") ?? false;
	let buffer = "";

	const absorb = (parsed: unknown) => {
		if (typeof parsed !== "object" || parsed === null) return;
		const record = parsed as Record<string, unknown>;
		const message =
			typeof record.message === "object" && record.message !== null
				? (record.message as Record<string, unknown>)
				: undefined;
		const model = record.model ?? message?.model;
		if (typeof model === "string") found.model = model;
		for (const usage of [record.usage, message?.usage]) {
			if (typeof usage !== "object" || usage === null) continue;
			found.usage ??= {};
			for (const [key, value] of Object.entries(usage)) {
				if (typeof value === "number") found.usage[key] = value;
			}
		}
	};

	return {
		feed(chunk: Uint8Array) {
			if (!isSse && !isJson) return;
			buffer += decoder.decode(chunk, { stream: true });
			if (!isSse) return;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.startsWith("data:")) continue;
				const data = line.slice(5).trim();
				if (!data || data === "[DONE]") continue;
				try {
					absorb(JSON.parse(data));
				} catch {
					// Not JSON; attribution stays usage-less for this event.
				}
			}
		},
		result() {
			if (isJson) {
				try {
					absorb(JSON.parse(buffer));
				} catch {
					// Non-JSON or truncated body; report what the stream yielded.
				}
			}
			return found;
		},
	};
}

/**
 * Forward `upstream` unchanged while feeding its chunks to the usage
 * collector, logging one attribution line when the body settles. Hand-rolled
 * reader loop for the same reason as `cleanupAfterStream` in ai-chat.route.ts:
 * Bun 1.3 honours neither `TransformStream.cancel` nor `finally` in an
 * async-generator body when the client cancels. Deliberately not shared with
 * that helper — the ai-chat path retires wholesale at v2 cutover (ADR-0034)
 * and must not become a dependency of the surviving code.
 */
function observeStream(
	upstream: Response,
	collector: ReturnType<typeof createUsageCollector>,
	logUsage: (
		outcome: "complete" | "cancelled" | "error",
		found: ReturnType<ReturnType<typeof createUsageCollector>["result"]>,
	) => void,
): ReadableStream<Uint8Array> | null {
	if (!upstream.body) {
		logUsage("complete", collector.result());
		return null;
	}
	const reader = upstream.body.getReader();
	let settled = false;
	const settle = (outcome: "complete" | "cancelled" | "error") => {
		if (settled) return;
		settled = true;
		logUsage(outcome, collector.result());
	};
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			let chunk: Awaited<ReturnType<typeof reader.read>>;
			try {
				chunk = await reader.read();
			} catch (error) {
				controller.error(error);
				settle("error");
				return;
			}
			if (chunk.done) {
				controller.close();
				settle("complete");
			} else {
				collector.feed(chunk.value);
				controller.enqueue(chunk.value);
			}
		},
		async cancel(reason) {
			await reader.cancel(reason).catch(() => {});
			settle("cancelled");
		},
	});
}

/**
 * Admit a VM's request on its Bearer gateway token, for this route and the
 * Checkpoint door (#670): the verified claims, or the opaque 401 — the
 * reason stays in the log, and nothing is forwarded or stored.
 */
export async function admitGatewayCaller(
	c: Context<AppEnv>,
	secret: string,
	conversationId: string,
): Promise<{ userId: string } | Response> {
	const token = (c.req.header("authorization") ?? "").replace(
		/^Bearer\s+/i,
		"",
	);
	const verdict = await verifyGatewayToken(token, { secret, conversationId });
	if (verdict.ok) return { userId: verdict.userId };
	c.var.logger.warn(
		{ conversationId, reason: verdict.reason },
		"gateway token rejected",
	);
	return c.json({ error: "Unauthorized" }, 401);
}

const routes = new Hono<AppEnv>();

routes.all("/:conversationId/*", async (c) => {
	const { config, gatewayUpstreamFetch } = c.var.deps;
	if (!config.openrouterApiKey || !config.gatewayTokenSecret) {
		return c.json({ error: "Gateway is not configured" }, 503);
	}
	const conversationId = c.req.param("conversationId");
	const admitted = await admitGatewayCaller(
		c,
		config.gatewayTokenSecret,
		conversationId,
	);
	if (admitted instanceof Response) return admitted;

	const url = new URL(c.req.url);
	const requestPath = url.pathname.slice(
		`/v2/gateway/${conversationId}`.length,
	);
	const upstreamUrl = config.openrouterBaseUrl + requestPath + url.search;
	const headers = new Headers(c.req.raw.headers);
	for (const name of STRIPPED_HEADERS) headers.delete(name);
	headers.set("authorization", `Bearer ${config.openrouterApiKey}`);
	headers.delete("x-api-key");

	// The request body is buffered (chat requests are small JSON); only the
	// response must stream unbuffered.
	const method = c.req.method;
	const upstream = await gatewayUpstreamFetch(upstreamUrl, {
		method,
		headers,
		body:
			method === "GET" || method === "HEAD"
				? undefined
				: await c.req.arrayBuffer(),
	});

	const collector = createUsageCollector(upstream.headers.get("content-type"));
	const body = observeStream(upstream, collector, (outcome, found) => {
		// The per-Conversation attribution feed (#545): one line per model call.
		c.var.logger.info(
			{
				conversationId,
				path: requestPath,
				status: upstream.status,
				outcome,
				model: found.model,
				usage: found.usage,
			},
			"gateway model call",
		);
	});

	const responseHeaders = new Headers(upstream.headers);
	for (const name of STRIPPED_HEADERS) responseHeaders.delete(name);
	return new Response(body, {
		status: upstream.status,
		headers: responseHeaders,
	});
});

export default routes;

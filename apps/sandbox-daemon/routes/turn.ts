import { timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { spawnAgent } from "../child-spawn";
import { acquireTurn } from "../turn-lock";

const app = new Hono();
const DAEMON_AUTH_HEADER = "x-daemon-auth-token";

// The agent's working directory inside the sandbox. Documents are no longer
// materialized to disk — the agent fetches them on demand via the
// `mymemo-docs` CLI (which calls the document-gateway) — so this is just an
// empty rw scratch dir for the agent's Bash/file tools.
// Must be a subpath of /workspace that bwrap re-binds rw (see child-spawn).
// Env-overridable so integration tests can point it at a temp dir.
function getAgentCwd(): string {
	return process.env.SANDBOX_AGENT_CWD ?? "/workspace/agent";
}

function authTokenMatches(
	presented: string | undefined,
	expected: string,
): boolean {
	if (!presented) return false;
	const presentedBuffer = Buffer.from(presented, "utf8");
	const expectedBuffer = Buffer.from(expected, "utf8");
	if (presentedBuffer.length !== expectedBuffer.length) return false;
	return timingSafeEqual(presentedBuffer, expectedBuffer);
}

interface TurnRequest {
	request_id: string;
	user_id: string;
	conversation_id: string;
	run_id: string;
	scope_type: "global" | "collection" | "document";
	collection_id?: string;
	summary_id?: string;
	message: string;
	agent_session_id?: string;
	system_prompt: string;
	llm_base_url: string;
	doc_gateway_url: string;
	llm_token: string;
	doc_token: string;
}

function ndjsonLine(obj: Record<string, unknown>): string {
	return `${JSON.stringify(obj)}\n`;
}

app.post("/turn", async (c) => {
	const expectedToken = process.env.DAEMON_AUTH_TOKEN;
	if (
		!expectedToken ||
		!authTokenMatches(c.req.header(DAEMON_AUTH_HEADER), expectedToken)
	) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const body = await c.req.json<TurnRequest>();

	if (
		!body.request_id ||
		!body.user_id ||
		!body.conversation_id ||
		!body.run_id ||
		!body.message ||
		!body.system_prompt ||
		!body.llm_base_url ||
		!body.doc_gateway_url ||
		!body.llm_token ||
		!body.doc_token
	) {
		return c.json({ error: "Missing required fields" }, 400);
	}

	const {
		request_id,
		conversation_id,
		run_id,
		message,
		agent_session_id,
		system_prompt,
		llm_base_url,
		doc_gateway_url,
		llm_token,
		doc_token,
	} = body;

	const lock = acquireTurn(request_id);
	if (!lock) {
		return c.json({ error: "Turn already in progress" }, 409);
	}

	return stream(
		c,
		async (s) => {
			c.header("Content-Type", "application/x-ndjson");

			try {
				await s.write(
					ndjsonLine({
						type: "started",
						turn_id: request_id,
						conversation_id,
						run_id,
					}),
				);

				const cwd = getAgentCwd();
				mkdirSync(cwd, { recursive: true });

				let turnFailed = false;
				let agentCompleted = false;
				const agentResult = await spawnAgent({
					userQuery: message,
					systemPrompt: system_prompt,
					cwd,
					sessionId: agent_session_id,
					llmBaseUrl: llm_base_url,
					docGatewayUrl: doc_gateway_url,
					llmToken: llm_token,
					docToken: doc_token,
					onEvent: async (event) => {
						if (event.type === "completed") {
							// We emit our own `completed` below.
							agentCompleted = true;
							return;
						}
						if (event.type === "failed") {
							turnFailed = true;
						}
						// Everything else (text_delta, session_id, heartbeat) is
						// forwarded as-is. Forwarding `heartbeat` is load-bearing:
						// it's the only traffic on this connection while a tool runs,
						// so it keeps Bun's idleTimeout and chat-api's read alive.
						// chat-api ignores it — it never reaches the end client.
						await s.write(ndjsonLine(event));
					},
				});

				// A non-zero exit after the agent already said `completed` is
				// teardown noise (e.g. the idle watchdog killing a lingering
				// child) — the answer fully streamed, so the turn succeeded.
				if (agentResult.exitCode !== 0 && !turnFailed && !agentCompleted) {
					turnFailed = true;
					await s.write(
						ndjsonLine({
							type: "failed",
							message: `agent exited with code ${agentResult.exitCode}`,
						}),
					);
				}

				if (!turnFailed) {
					await s.write(ndjsonLine({ type: "completed" }));
				}
			} catch (err) {
				const errorMessage = err instanceof Error ? err.message : String(err);
				await s.write(ndjsonLine({ type: "failed", message: errorMessage }));
			} finally {
				lock.release();
			}
		},
		async (err, stream) => {
			const message = err instanceof Error ? err.message : String(err);
			console.error("Stream error in /turn:", message);
			await stream.write(ndjsonLine({ type: "failed", message }));
			lock.release();
		},
	);
});

export default app;

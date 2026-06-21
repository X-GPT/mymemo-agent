import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { spawnAgent } from "../child-spawn";
import type { DaemonConfig } from "../config";
import {
	bindConversationScope,
	ConversationScopeMismatchError,
} from "../conversation-scope";
import { acquireTurn } from "../turn-lock";
import {
	assertValidConversationId,
	createConversationWorkspace,
	resolveConversationWorkspace,
} from "../workspace";

const DAEMON_AUTH_HEADER = "x-daemon-auth-token";

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

/**
 * /turn route factory. Receives the daemon config so it reads no ambient env:
 * the bearer secret, workspace root, and agent-spawn settings all arrive by
 * injection from `daemon-entry.ts`.
 */
export function createTurnRoutes(config: DaemonConfig): Hono {
	const app = new Hono();

	app.post("/turn", async (c) => {
		const expectedToken = config.daemonAuthToken;
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

		// conversation_id is joined into the workspace path; reject anything that
		// could escape the conversation subtree before touching the filesystem.
		try {
			assertValidConversationId(body.conversation_id);
		} catch {
			return c.json({ error: "Invalid conversation_id" }, 400);
		}

		// A conversation's document scope is immutable. The first turn binds it; a
		// later turn that changes scope is rejected before anything streams, so a
		// reused workspace can never serve a narrower turn documents the original
		// broader-scope turn hydrated to disk (MYM-39). The id is validated above,
		// so resolving the conversation dir here is safe.
		try {
			bindConversationScope(
				resolveConversationWorkspace(body.conversation_id, config.workspaceRoot)
					.conversation,
				{
					scopeType: body.scope_type,
					collectionId: body.collection_id ?? null,
					summaryId: body.summary_id ?? null,
				},
			);
		} catch (err) {
			if (err instanceof ConversationScopeMismatchError) {
				return c.json({ error: "Conversation scope is immutable" }, 409);
			}
			return c.json({ error: "Failed to resolve conversation scope" }, 500);
		}

		const {
			request_id,
			user_id,
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

					// Materialize the conversation workspace tree and run the agent
					// from its `work/` dir (created before spawn so the cwd exists).
					const workspace = createConversationWorkspace(
						conversation_id,
						config.workspaceRoot,
					);
					const cwd = workspace.work;

					let turnFailed = false;
					let agentCompleted = false;
					const agentResult = await spawnAgent(
						{
							userQuery: message,
							systemPrompt: system_prompt,
							cwd,
							// Per-conversation CLAUDE_CONFIG_DIR — owned by the workspace
							// layout (a sibling of cwd), bound rw and set on the agent so its
							// SDK config + transcripts stay isolated from the project `.claude`.
							claudeConfigDir: workspace.claudeConfig,
							// docs/ is bound rw and forwarded to the `search_documents` tool as
							// its hydration target; run_id attributes hydration in the manifest.
							docsDir: workspace.docs,
							runId: run_id,
							sessionId: agent_session_id,
							// Identity keys the durable session-transcript store; both arrive
							// validated from the trusted turn request.
							userId: user_id,
							conversationId: conversation_id,
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
						},
						config.agentSpawn,
					);

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

	return app;
}

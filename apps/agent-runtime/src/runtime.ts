import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	GetObjectCommand,
	PutObjectCommand,
	type S3Client,
} from "@aws-sdk/client-s3";
import {
	createScopedDocumentClient,
	type KbDb,
	parseFrozenScope,
} from "@mymemo/document-tools/client";
import { query } from "claude-agent-sdk";
import pino from "pino";
import { z } from "zod";
import { createDocs, docsToolAliases } from "./docs";
import { createHand, type HandInvoke, invokeHand, toolAliases } from "./hand";

export const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
export const RUNTIME_CWD = "/opt/mymemo/project";

const id = z.string().min(1);
export const invocationSchema = z
	.strictObject({
		conversationId: z.uuid(),
		turnId: z.uuid(),
		seq: z.number().int().positive(),
		requestId: id,
		userId: id,
		scope: z.discriminatedUnion("kind", [
			z.strictObject({ kind: z.literal("general") }),
			z.strictObject({ kind: z.literal("collection"), collectionId: id }),
			z.strictObject({ kind: z.literal("document"), summaryId: id }),
		]),
		text: z
			.string()
			.refine(
				(text) => text.trim().length > 0 && Buffer.byteLength(text) <= 32768,
			),
		startedAt: z.number().int().nonnegative(),
		budgetUntil: z.number().int().nonnegative(),
		sandboxSessionId: id,
	})
	.refine(
		(input) =>
			input.budgetUntil > input.startedAt &&
			input.budgetUntil <= input.startedAt + 720_000,
	);

export function createRuntimeServer(
	config: {
		model: string;
		env: Record<string, string | undefined>;
		pathToClaudeCodeExecutable: string;
		cwd?: string;
		s3: S3Client;
		bucket: string;
		kb: KbDb;
		port?: number;
		codeInterpreterId?: string;
		handInvoke?: (sessionId: string, signal: AbortSignal) => HandInvoke;
	},
	runQuery = query,
) {
	const cwd = config.cwd ?? RUNTIME_CWD;
	let busy = false;
	const server = Bun.serve({
		port: config.port ?? 0,
		hostname: "0.0.0.0",
		idleTimeout: 0,
		maxRequestBodySize: 65536,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/ping" && request.method === "GET") {
				return Response.json({ status: busy ? "HealthyBusy" : "Healthy" });
			}
			if (path !== "/invocations" || request.method !== "POST" || busy) {
				return new Response(null, { status: busy ? 503 : 404 });
			}
			busy = true;
			let active: ReturnType<typeof query> | undefined;
			let configDir: string | undefined;
			let transcriptPath = "";
			let transcriptKey = "";
			let receivedResult = false;
			let childExited: Promise<void> | undefined;
			let budgetTimer: ReturnType<typeof setTimeout> | undefined;
			let graceTimer: ReturnType<typeof setTimeout> | undefined;
			let budgetExpired = false;
			let sandboxLost: Error | undefined;
			let binding = {};
			const encoder = new TextEncoder();
			let disconnected = false;
			const abortController = new AbortController();
			const disconnect = () => {
				if (disconnected) return;
				disconnected = true;
				abortController.abort();
				active?.close();
				void server.stop();
			};
			request.signal.addEventListener("abort", disconnect, { once: true });
			const run = async function* () {
				try {
					try {
						const input = invocationSchema.parse(await request.json());
						binding = {
							conversationId: input.conversationId,
							turnId: input.turnId,
						};
						await mkdir(cwd, { recursive: true });
						configDir = `/tmp/claude/${input.turnId}`;
						transcriptPath = join(
							configDir,
							"projects",
							cwd.replace(/[^a-zA-Z0-9]/g, "-"),
							`${input.conversationId}.jsonl`,
						);
						transcriptKey = `_transcripts/${input.conversationId}.jsonl`;
						await mkdir(dirname(transcriptPath), { recursive: true });
						let resumed = false;
						try {
							const object = await config.s3.send(
								new GetObjectCommand({
									Bucket: config.bucket,
									Key: transcriptKey,
								}),
							);
							if (!object.Body) throw new Error("Transcript body is missing");
							await writeFile(
								transcriptPath,
								await object.Body.transformToByteArray(),
							);
							resumed = true;
						} catch (error) {
							// S3 hides missing keys behind AccessDenied without ListBucket.
							// Only the first Turn can safely start without prior memory.
							if (
								!(
									input.seq === 1 &&
									error instanceof Error &&
									["NoSuchKey", "AccessDenied"].includes(error.name)
								)
							)
								throw error;
						}
						if (disconnected) return;
						const hand = createHand(
							config.handInvoke?.(
								input.sandboxSessionId,
								abortController.signal,
							) ??
								invokeHand(
									config.codeInterpreterId ?? "",
									input.sandboxSessionId,
									abortController.signal,
								),
							(error) => {
								sandboxLost = error;
								abortController.abort();
								active?.close();
							},
						);

						const docs = createDocs(
							createScopedDocumentClient({
								kb: config.kb,
								userId: input.userId,
								scope: parseFrozenScope({
									scope: input.scope.kind,
									collectionId:
										input.scope.kind === "collection"
											? input.scope.collectionId
											: null,
									summaryId:
										input.scope.kind === "document"
											? input.scope.summaryId
											: null,
								}),
								logger,
							}),
							hand,
							abortController.signal,
						);
						const aliases = { ...toolAliases, ...docsToolAliases };
						active = runQuery({
							prompt: input.text,
							options: {
								abortController,
								...(resumed
									? { resume: input.conversationId }
									: { sessionId: input.conversationId }),
								// The SDK can finish iteration before the CLI exits on abort.
								// Wait for the child before removing its config directory.
								spawnClaudeCodeProcess(options) {
									const child = spawn(options.command, options.args, {
										cwd: options.cwd,
										env: options.env,
										signal: options.signal,
										stdio: ["pipe", "pipe", "ignore"],
									});
									childExited = new Promise((resolve) =>
										child.once("close", () => resolve()),
									);
									return child;
								},
								model: config.model,
								env: { ...config.env, CLAUDE_CONFIG_DIR: configDir },
								cwd,
								pathToClaudeCodeExecutable: config.pathToClaudeCodeExecutable,
								tools: [],
								mcpServers: { hand, docs },
								toolAliases: aliases,
								allowedTools: Object.values(aliases),
								permissionMode: "dontAsk",
								settingSources: [],
								includePartialMessages: true,
								thinking: { type: "enabled", budgetTokens: 1024 },
								systemPrompt:
									"You are MyMemo's assistant. Answer the user's questions concisely. Your working directory is /ws. Use the Hand tools for all files and shell commands. The workspace persists across Turns and is limited to 64 MiB compressed; large data belongs in the knowledge base. Use ListDocuments and SearchDocuments to discover documents within this Conversation’s Scope, then LoadDocuments to cache them under /ws/.mymemo/docs. Read or Grep the returned paths.",
							},
						});
						budgetTimer = setTimeout(
							() => {
								budgetExpired = true;
								// interrupt preserves the SDK's terminal result; close discards it.
								void active?.interrupt().catch(() => active?.close());
							},
							Math.max(0, input.budgetUntil - 120_000 - Date.now()),
						);
						graceTimer = setTimeout(
							() => abortController.abort(),
							Math.max(0, input.budgetUntil - Date.now()),
						);
						for await (const message of active) {
							if (sandboxLost) throw sandboxLost;
							if (message.type === "result") receivedResult = true;
							yield encoder.encode(`${JSON.stringify(message)}\n`);
							// A single-prompt query ends at result. The SDK throws again after
							// an error result; that is not a second Runtime-side failure.
							if (message.type === "result") break;
						}
						if (sandboxLost) throw sandboxLost;
					} finally {
						clearTimeout(budgetTimer);
						clearTimeout(graceTimer);
						active?.close();
						try {
							await active?.return(undefined);
							await childExited;
						} finally {
							try {
								if (receivedResult) {
									await config.s3.send(
										new PutObjectCommand({
											Bucket: config.bucket,
											Key: transcriptKey,
											Body: await readFile(transcriptPath),
											ContentType: "application/x-ndjson",
										}),
									);
								}
							} catch (error) {
								logger.error({
									...binding,
									err: error,
									msg: "Transcript upload failed",
									TranscriptUploadFailures: 1,
									_aws: {
										Timestamp: Date.now(),
										CloudWatchMetrics: [
											{
												Namespace: "MyMemo/AgentRuntime",
												Dimensions: [[]],
												Metrics: [
													{ Name: "TranscriptUploadFailures", Unit: "Count" },
												],
											},
										],
									},
								});
							} finally {
								if (configDir)
									await rm(configDir, { recursive: true, force: true });
							}
						}
					}
				} catch (error) {
					const detail = error instanceof Error ? error.message : String(error);
					logger.error({ ...binding, message: "Turn failed", detail });
					if (!disconnected)
						yield encoder.encode(
							`${JSON.stringify({ type: "mymemo.error", code: "internal_error", detail })}\n`,
						);
				} finally {
					request.signal.removeEventListener("abort", disconnect);
					busy = false;
					if (budgetExpired) void server.stop();
				}
			};
			const messages = run();
			const readable = new ReadableStream<Uint8Array>({
				async pull(controller) {
					const next = await messages.next();
					if (disconnected) return;
					if (next.done) controller.close();
					else controller.enqueue(next.value);
				},
				async cancel() {
					disconnect();
					await messages.return();
				},
			});
			return new Response(readable, {
				headers: { "content-type": "application/x-ndjson" },
			});
		},
	});
	return server;
}

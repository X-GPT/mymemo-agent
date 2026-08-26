import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	InMemorySessionStore,
	type SessionKey,
	type SessionStoreEntry,
	query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { DetachedSessionStore } from "./detached-session-store";

const encoder = new TextEncoder();
const sessionKeySchema = z.strictObject({
	projectKey: z.string().min(1),
	sessionId: z.string().min(1),
	subpath: z.string().min(1).optional(),
});
const detachedStateSchema = z
	.strictObject({
		version: z.literal(1),
		sessionId: z.string().min(1),
		transcripts: z.array(
			z.strictObject({
				key: sessionKeySchema,
				entries: z.array(z.looseObject({ type: z.string() })),
			}),
		),
	})
	.refine(
		(state) =>
			state.transcripts.every(
				(transcript) => transcript.key.sessionId === state.sessionId,
			),
		{ message: "Detached Agent session contains another session id" },
	);

type DetachedState = z.infer<typeof detachedStateSchema>;

class InvocationSessionStore extends InMemorySessionStore {
	readonly #keys = new Map<string, SessionKey>();

	override async append(key: SessionKey, entries: SessionStoreEntry[]) {
		this.#keys.set(
			JSON.stringify([key.projectKey, key.sessionId, key.subpath]),
			{
				...key,
			},
		);
		await super.append(key, entries);
	}

	override async delete(key: SessionKey) {
		await super.delete(key);
		for (const [id, storedKey] of this.#keys) {
			if (
				storedKey.projectKey === key.projectKey &&
				storedKey.sessionId === key.sessionId &&
				(key.subpath === undefined || storedKey.subpath === key.subpath)
			) {
				this.#keys.delete(id);
			}
		}
	}

	async hydrate(state: DetachedState) {
		for (const transcript of state.transcripts) {
			await this.append(transcript.key, transcript.entries);
		}
	}

	detach(sessionId: string): DetachedState {
		const state = JSON.parse(
			JSON.stringify({
				version: 1,
				sessionId,
				transcripts: [...this.#keys.values()]
					.filter((key) => key.sessionId === sessionId)
					.map((key) => ({ key, entries: this.getEntries(key) })),
			}),
		) as DetachedState;
		this.clear();
		this.#keys.clear();
		return state;
	}
}

function createAgent(options: {
	query: typeof sdkQuery;
	environment: Record<string, string | undefined>;
}) {
	return {
		async createSession(input: {
			conversationId: string;
			runId: string;
			state: unknown | null;
		}) {
			const state =
				input.state === null ? null : detachedStateSchema.parse(input.state);
			const store = new InvocationSessionStore();
			if (state) await store.hydrate(state);
			const configDirectory = await mkdtemp(
				join(tmpdir(), `mymemo-agent-query-${input.runId}-`),
			);
			let drained = false;
			let sessionId = state?.sessionId;

			return {
				async *stream(turn: { model: string; prompt: string; cwd: string }) {
					try {
						const query = options.query({
							prompt: turn.prompt,
							options: {
								env: {
									...options.environment,
									CLAUDE_CONFIG_DIR: configDirectory,
								},
								model: turn.model,
								includePartialMessages: true,
								cwd: turn.cwd,
								permissionMode: "dontAsk",
								sessionStore: store,
								settingSources: [],
								thinking: { type: "disabled" },
								tools: [],
								...(sessionId ? { resume: sessionId } : {}),
							},
						});
						for await (const message of query) {
							if ("session_id" in message && message.session_id) {
								sessionId = message.session_id;
							}
							yield message;
						}
						drained = true;
					} finally {
						await rm(configDirectory, { recursive: true, force: true });
					}
				},
				detach() {
					if (!drained || !sessionId) {
						throw new Error(
							`Cannot detach Agent session for ${input.runId} before full drain`,
						);
					}
					return store.detach(sessionId);
				},
			};
		},
	};
}

export function createResponseStream(
	input: {
		conversationId: string;
		runId: string;
		model: string;
		prompt: string;
	},
	options: {
		objectStore: DetachedSessionStore;
		environment?: Record<string, string | undefined>;
		query?: typeof sdkQuery;
		prepareWorkingDirectory?: (path: string) => Promise<void>;
	},
): ReadableStream<Uint8Array> {
	const query = options.query ?? sdkQuery;
	const prepareWorkingDirectory =
		options.prepareWorkingDirectory ??
		(async (path: string) => {
			await mkdir(path, { recursive: true });
		});

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				const state = await options.objectStore.load(input.conversationId);
				const cwd = `/workspace/conversations/${input.conversationId}`;
				await prepareWorkingDirectory(cwd);
				const session = await createAgent({
					query,
					environment: options.environment ?? Bun.env,
				}).createSession({
					conversationId: input.conversationId,
					runId: input.runId,
					state,
				});
				for await (const message of session.stream({
					model: input.model,
					prompt: input.prompt,
					cwd,
				})) {
					controller.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
				}
				await options.objectStore.save(input.conversationId, session.detach());
				controller.close();
			} catch (error) {
				controller.error(error);
			}
		},
	});
}

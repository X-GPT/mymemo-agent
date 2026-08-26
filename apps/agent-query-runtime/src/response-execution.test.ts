import { expect, it } from "bun:test";
import type {
	InMemorySessionStore,
	Options,
	query,
	SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { DetachedSessionStore } from "./detached-session-store";
import { createResponseStream } from "./response-execution";
import { createResponseInvocationHandler } from "./server";

function invocationRequest(runId: string, prompt: string) {
	return new Request("http://runtime/invocations", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-amzn-bedrock-agentcore-runtime-session-id": "conversation-1",
		},
		body: JSON.stringify({
			runId,
			model: "anthropic/claude-sonnet-5",
			prompt,
		}),
	});
}

it("runs a fresh no-tool query and streams raw SDK messages", async () => {
	const message = {
		type: "system",
		subtype: "init",
		session_id: "session-1",
	} as SDKMessage;
	let queryOptions: Options | undefined;
	let savedState: unknown;
	const body = createResponseStream(
		{
			conversationId: "conversation-1",
			runId: "response-1",
			model: "anthropic/claude-sonnet-5",
			prompt: "hello",
		},
		{
			sessionStateStore: {
				load: async () => null,
				save: async (_conversationId, state) => {
					savedState = state;
				},
			},
			environment: { PATH: "/usr/bin", ANTHROPIC_AUTH_TOKEN: "secret" },
			prepareWorkingDirectory: async () => {},
			query: ((input: { options: Options }) => {
				queryOptions = input.options;
				return (async function* () {
					yield message;
				})();
			}) as unknown as typeof query,
		},
	);

	expect(await new Response(body).text()).toBe(`${JSON.stringify(message)}\n`);
	expect(queryOptions?.persistSession).toBeUndefined();
	expect(queryOptions?.sessionStore).toBeDefined();
	expect(queryOptions?.model).toBe("anthropic/claude-sonnet-5");
	expect(queryOptions?.tools).toEqual([]);
	expect(queryOptions?.env).toMatchObject({
		PATH: "/usr/bin",
		ANTHROPIC_AUTH_TOKEN: "secret",
	});
	expect(queryOptions?.env?.CLAUDE_CONFIG_DIR).toContain(
		"mymemo-agent-query-response-1-",
	);
	expect(savedState).toEqual({
		version: 1,
		sessionId: "session-1",
		transcripts: [],
	});
});

it("continues through detached state only after fully draining each isolated invocation", async () => {
	let detachedState: unknown | null = null;
	const operations: string[] = [];
	const sessionStateStore: DetachedSessionStore = {
		async load(conversationId) {
			operations.push(`load:${conversationId}`);
			return structuredClone(detachedState);
		},
		async save(conversationId, state) {
			operations.push(`save:${conversationId}`);
			detachedState = structuredClone(state);
		},
	};
	const liveStores: InMemorySessionStore[] = [];
	let turns = 0;
	const fakeQuery = ((input: { prompt: string; options: Options }) => {
		const store = input.options.sessionStore as InMemorySessionStore;
		liveStores.push(store);
		const turn = ++turns;
		const sessionId = input.options.resume ?? "session-1";
		return (async function* () {
			const key = { projectKey: "project-1", sessionId };
			const prior = await store.load(key);
			yield {
				type: "system",
				subtype: "init",
				session_id: sessionId,
				continued: prior?.some(
					(entry) => entry.privateValue === "remember blue",
				),
			} as unknown as SDKMessage;
			yield {
				type: "result",
				subtype: "success",
				is_error: false,
				session_id: sessionId,
			} as SDKMessage;
			await store.append(key, [
				{
					type: "user",
					uuid: `entry-${turn}`,
					privateValue: input.prompt,
					lateAfterResult: true,
				},
			]);
		})();
	}) as unknown as typeof query;
	const makeHandler = () =>
		createResponseInvocationHandler((request) =>
			createResponseStream(request, {
				sessionStateStore,
				query: fakeQuery,
				prepareWorkingDirectory: async () => {},
				environment: {},
			}),
		);
	const invoke = (
		handler: ReturnType<typeof makeHandler>,
		runId: string,
		prompt: string,
	) => handler(invocationRequest(runId, prompt));

	const first = await invoke(makeHandler(), "response-1", "remember blue");
	const firstBody = await first.text();
	const second = await invoke(makeHandler(), "response-2", "what was it?");
	const secondBody = await second.text();

	expect(secondBody).toContain('"continued":true');
	expect(`${firstBody}${secondBody}`).not.toContain("privateValue");
	expect(JSON.stringify(detachedState)).not.toContain("response-1");
	expect(JSON.stringify(detachedState)).not.toContain("response-2");
	expect(operations).toEqual([
		"load:conversation-1",
		"save:conversation-1",
		"load:conversation-1",
		"save:conversation-1",
	]);
	expect(liveStores).toHaveLength(2);
	expect(liveStores[0]).not.toBe(liveStores[1]);
	expect(liveStores.every((store) => store.size === 0)).toBe(true);
	expect(JSON.stringify(detachedState)).toContain('"lateAfterResult":true');
});

it("persists one complete snapshot from overlapping same-Conversation invocations", async () => {
	const snapshots: unknown[] = [];
	let retained: unknown | null = null;
	const sessionStateStore: DetachedSessionStore = {
		load: async () => null,
		async save(_conversationId, state) {
			const snapshot = structuredClone(state);
			snapshots.push(snapshot);
			retained = snapshot;
		},
	};
	const liveStores: InMemorySessionStore[] = [];
	let sessions = 0;
	const fakeQuery = ((input: { prompt: string; options: Options }) => {
		const store = input.options.sessionStore as InMemorySessionStore;
		liveStores.push(store);
		const sessionId = `session-${++sessions}`;
		return (async function* () {
			await store.append({ projectKey: "project-1", sessionId }, [
				{ type: "user", privateValue: input.prompt },
			]);
			yield {
				type: "result",
				subtype: "success",
				is_error: false,
				session_id: sessionId,
			} as SDKMessage;
		})();
	}) as unknown as typeof query;
	const handler = createResponseInvocationHandler((request) =>
		createResponseStream(request, {
			sessionStateStore,
			query: fakeQuery,
			prepareWorkingDirectory: async () => {},
			environment: {},
		}),
	);
	const invoke = (runId: string, prompt: string) =>
		handler(invocationRequest(runId, prompt)).then((response) =>
			response.text(),
		);

	await Promise.all([
		invoke("response-1", "sibling one"),
		invoke("response-2", "sibling two"),
	]);

	expect(liveStores).toHaveLength(2);
	expect(liveStores[0]).not.toBe(liveStores[1]);
	expect(liveStores.every((store) => store.size === 0)).toBe(true);
	expect(snapshots).toHaveLength(2);
	const serialized = snapshots.map((state) => JSON.stringify(state));
	expect(
		serialized.filter((state) => state.includes("sibling one")),
	).toHaveLength(1);
	expect(
		serialized.filter((state) => state.includes("sibling two")),
	).toHaveLength(1);
	expect(
		serialized.every(
			(state) =>
				state.includes("sibling one") !== state.includes("sibling two"),
		),
	).toBe(true);
	expect(retained).toEqual(snapshots.at(-1));
});

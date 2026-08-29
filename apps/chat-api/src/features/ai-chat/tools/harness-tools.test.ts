import { expect, it } from "bun:test";
import type { ScopedDocumentClient } from "./document-client";
import { DOCS_CACHE_DIRNAME } from "./document-tools";
import {
	createHarnessTools,
	HARNESS_ACTIVE_TOOLS,
	HARNESS_BUILTIN_TOOLS,
	HARNESS_TOOL_NAMES,
	type HarnessSandboxSession,
} from "./harness-tools";

const binding = {
	userId: "member-1",
	conversationId: "conv-1",
	turnId: "turn-1",
};
const logger = { info() {}, error() {} };

function client(overrides: Partial<ScopedDocumentClient> = {}) {
	return {
		list: async () => ({ total: 0, documents: [], next: null }),
		search: async () => [],
		fetch: async (documentId: string) => ({
			documentId,
			title: "T",
			content: "body",
			truncated: false,
		}),
		...overrides,
	} satisfies ScopedDocumentClient;
}

/** A session whose every method throws; LoadDocuments' `writeTextFile` records instead. */
function session(writes?: { path: string; content: string }[]) {
	const throwing = async () => {
		throw new Error("session method must not be called");
	};
	return {
		description: "fake",
		readFile: throwing,
		readBinaryFile: throwing,
		readTextFile: throwing,
		writeFile: throwing,
		writeBinaryFile: throwing,
		writeTextFile: writes
			? async (input: { path: string; content: string }) => {
					writes.push({ path: input.path, content: input.content });
				}
			: throwing,
		spawn: throwing,
		run: throwing,
	} as unknown as HarnessSandboxSession;
}

const call = {
	toolCallId: "c1",
	messages: [],
	context: undefined as never,
	abortSignal: undefined,
};

it("names exactly the document tools next to the four built-ins", () => {
	const { tools } = createHarnessTools({ client: client(), binding, logger });
	expect(Object.keys(tools)).toEqual([...HARNESS_TOOL_NAMES]);
	expect(HARNESS_ACTIVE_TOOLS).toEqual([
		...HARNESS_BUILTIN_TOOLS,
		...HARNESS_TOOL_NAMES,
	]);
});

it("execute resolves the handler's plain JSON and rejects with a failure's text", async () => {
	const { tools } = createHarnessTools({
		client: client({
			search: async () => [
				{ passageId: "p1", documentId: "d1", title: "A", snippet: "s" },
			],
		}),
		binding,
		logger,
	});
	await expect(
		tools.SearchDocuments.execute({ query: "revenue" }),
	).resolves.toEqual({
		passages: [{ passageId: "p1", documentId: "d1", title: "A", snippet: "s" }],
	});
	await expect(tools.SearchDocuments.execute({ query: "   " })).rejects.toThrow(
		"SearchDocuments requires a non-empty query.",
	);
});

it("LoadDocuments writes every document through the session it is handed, under the session work directory", async () => {
	const { tools, onSession } = createHarnessTools({
		client: client(),
		binding,
		logger,
	});
	const writes: { path: string; content: string }[] = [];
	await onSession({
		session: session(),
		sessionWorkDir: "/vercel/sandbox/cc-conv-1",
	});
	const result = await tools.LoadDocuments.execute(
		{ documentIds: ["d1", "d2"] },
		{ ...call, experimental_sandbox: session(writes) },
	);
	expect(writes).toEqual([
		{
			path: `/vercel/sandbox/cc-conv-1/${DOCS_CACHE_DIRNAME}/d1.md`,
			content: "body",
		},
		{
			path: `/vercel/sandbox/cc-conv-1/${DOCS_CACHE_DIRNAME}/d2.md`,
			content: "body",
		},
	]);
	expect(result.loaded.map((d) => d.path)).toEqual(writes.map((w) => w.path));
});

it("ListDocuments and SearchDocuments complete when handed a session whose methods throw", async () => {
	const { tools } = createHarnessTools({ client: client(), binding, logger });
	// Their signatures take no options; the bridge passes them regardless.
	type Loose = (input: object, options: object) => Promise<unknown>;
	const run = (tool: { execute: (input: never) => Promise<unknown> }) =>
		(tool.execute as unknown as Loose).bind(tool);
	const options = { ...call, experimental_sandbox: session() };
	await expect(run(tools.ListDocuments)({}, options)).resolves.toEqual({
		total: 0,
		documents: [],
		nextCursor: null,
	});
	await expect(
		run(tools.SearchDocuments)({ query: "x" }, options),
	).resolves.toEqual({
		passages: [],
		message: "No MyMemo document passages matched the query.",
	});
});

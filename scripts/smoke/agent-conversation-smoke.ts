#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PublicToolName } from "../../packages/agent-db/src/run-events";
import {
	type ClientContractMessage,
	type ClientContractTerminal,
	createClientContractFixture,
} from "./client-contract";

const baseUrl = requiredEnv("AGENT_SMOKE_BASE_URL").replace(/\/+$/, "");
const memberCode = Bun.env.AGENT_SMOKE_MEMBER_CODE || "agent-smoke-member";
const partnerCode = Bun.env.AGENT_SMOKE_PARTNER_CODE || "agent-smoke-partner";
const expectGateClosed = Bun.env.AGENT_SMOKE_EXPECT_GATE_CLOSED !== "false";
const suite = parseSuite(Bun.env.AGENT_SMOKE_SUITE);
const FIXTURE_MEMBER_CODE = "demo-member";
if (suite === "full" && memberCode !== FIXTURE_MEMBER_CODE) {
	throw new Error(
		"AGENT_SMOKE_SUITE=full requires AGENT_SMOKE_MEMBER_CODE=demo-member (the seeded local fixture member)",
	);
}
const rawTurnTimeout = Bun.env.AGENT_SMOKE_TURN_TIMEOUT_MS;
const turnTimeoutMs =
	rawTurnTimeout === undefined ? 180_000 : Number(rawTurnTimeout);
if (!Number.isInteger(turnTimeoutMs) || turnTimeoutMs <= 0) {
	throw new Error("AGENT_SMOKE_TURN_TIMEOUT_MS must be a positive integer");
}

const TURN_HISTORY_EVENT_TYPES = [
	"RUN_STARTED",
	"TEXT_MESSAGE_START",
	"TEXT_MESSAGE_CONTENT",
	"TEXT_MESSAGE_END",
	"TOOL_CALL_START",
	"TOOL_CALL_ARGS",
	"TOOL_CALL_END",
	"TOOL_CALL_RESULT",
	"CUSTOM",
] as const;

const TURN_EVENT_TYPES: ReadonlySet<string> = new Set([
	...TURN_HISTORY_EVENT_TYPES,
	"RUN_FINISHED",
]);
const INTERRUPTED_TURN_EVENT_TYPES: ReadonlySet<string> = new Set([
	...TURN_HISTORY_EVENT_TYPES,
	"RUN_CANCELLED",
]);

interface SSEFrame {
	event: string;
	data: string;
}

interface TurnResult {
	runId: string;
	text: string;
	toolFrames: DurableToolFrame[];
}

interface DurableToolFrame {
	event:
		| "TOOL_CALL_START"
		| "TOOL_CALL_ARGS"
		| "TOOL_CALL_END"
		| "TOOL_CALL_RESULT"
		| "CUSTOM";
	data: unknown;
}

interface ReplayExpectation {
	conversationId: string;
	runId: string;
	messages: ClientContractMessage[];
	toolFrames: DurableToolFrame[];
	terminal?: ClientContractTerminal;
}

interface ArtifactMetadata {
	artifactId?: unknown;
	path?: unknown;
	sizeBytes?: unknown;
}

const CORE_ARTIFACT_PATH = "smoke/core-check.txt";
const FIXTURE_SEARCHABLE_DOCUMENT_COUNT = 2;
const FIXTURE_SEARCHABLE_DOCUMENT_TITLE = "MyMemo Overview";
const FIXTURE_SEARCHABLE_DOCUMENT_HEADING = "# MyMemo Overview";

function requiredEnv(name: string): string {
	const value = Bun.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function headers(): HeadersInit {
	return {
		"Content-Type": "application/json",
		"X-Member-Code": memberCode,
		"X-Partner-Code": partnerCode,
	};
}

const create = await requestConversationCreate();

if (expectGateClosed) {
	if (create.status !== 403) {
		throw new Error(
			`expected Statsig gate to be closed with 403, got ${create.status}`,
		);
	}
	console.log("agent smoke passed: Statsig gate is closed by default");
	process.exit(0);
}

const conversationId = await requireCreatedConversation(create);

const sessionMarker = `agent-session-${randomUUID()}`;
const firstTurn = await sendTurn(
	conversationId,
	[
		"You are running an automated two-turn live smoke test.",
		`Remember this exact agent-session marker for the next turn: ${sessionMarker}`,
		"Do not write that marker to the workspace and do not include it in this turn's reply.",
		"You must use the Bash tool to run exactly this command in the E2B workspace:",
		'python3 -c \'import hashlib,secrets; from pathlib import Path; value="workspace-"+secrets.token_hex(16); Path("/home/user/.mymemo-live-smoke").write_text(value); print(hashlib.sha256(value.encode()).hexdigest())\'',
		"The command creates a random workspace marker and prints only its SHA-256. Do not read the file after creating it.",
		"Reply with exactly TURN1_SHA256=<the printed SHA-256> and nothing else.",
	].join("\n"),
);
const expectedWorkspaceHash = firstTurn.text.match(
	/\bTURN1_SHA256=([0-9a-f]{64})\b/i,
)?.[1];
if (!expectedWorkspaceHash) {
	throw new Error(
		`first run did not return the workspace SHA-256 marker: ${firstTurn.text}`,
	);
}

const secondTurn = await sendTurn(
	conversationId,
	[
		"Complete the second half of the live smoke using the previous turn's context.",
		"Recall the exact agent-session marker I asked you to remember; do not ask me to repeat it.",
		"Use the Read tool to read /home/user/.mymemo-live-smoke from the existing E2B workspace.",
		"Reply with exactly these two lines, replacing both placeholders:",
		"SESSION_MARKER=<the exact marker from the previous turn>",
		"WORKSPACE_MARKER=<the exact file contents>",
	].join("\n"),
);
if (secondTurn.runId === firstTurn.runId) {
	throw new Error("second turn reused the first run id");
}
if (!secondTurn.text.includes(`SESSION_MARKER=${sessionMarker}`)) {
	throw new Error(
		`second run did not resume the prior agent session: ${secondTurn.text}`,
	);
}
const workspaceMarker = secondTurn.text.match(
	/\bWORKSPACE_MARKER=(workspace-[0-9a-f]{32})\b/i,
)?.[1];
if (!workspaceMarker) {
	throw new Error(
		`second run did not return the persisted workspace marker: ${secondTurn.text}`,
	);
}
const actualWorkspaceHash = createHash("sha256")
	.update(workspaceMarker)
	.digest("hex");
if (actualWorkspaceHash !== expectedWorkspaceHash.toLowerCase()) {
	throw new Error(
		"second run returned workspace contents that do not match the first run's SHA-256",
	);
}
if (firstTurn.text !== `TURN1_SHA256=${actualWorkspaceHash}`) {
	throw new Error(
		"first run commit was not the exact requested Assistant message",
	);
}
const expectedSecondText = `SESSION_MARKER=${sessionMarker}\nWORKSPACE_MARKER=${workspaceMarker}`;
if (secondTurn.text !== expectedSecondText) {
	throw new Error(
		"second run commit was not the exact requested Assistant message",
	);
}

const artifactContent = `mymemo-core-artifact-${randomUUID()}`;
const artifactTurn = await sendTurn(
	conversationId,
	[
		"Create exactly one Downloadable artifact for this automated smoke test.",
		`ARTIFACT_PATH=/home/user/artifacts/${CORE_ARTIFACT_PATH}`,
		`ARTIFACT_CONTENT=${artifactContent}`,
		"Use the Write tool to write the ARTIFACT_CONTENT value as the file's exact UTF-8 contents, with no trailing newline.",
		"Do not create any other file under /home/user/artifacts.",
		"Reply with exactly ARTIFACT_WRITTEN and nothing else.",
	].join("\n"),
);
await verifyArtifact(conversationId, artifactContent);

let fullSuiteEvidence = "";
if (suite === "full") {
	const interruptConversationId = await requireCreatedConversation(
		await requestConversationCreate(),
	);
	const interruptedTurn = await verifyRunningRunCancellation(
		interruptConversationId,
	);
	fullSuiteEvidence = `; interrupt conversation ${interruptConversationId}; run ${interruptedTurn.runId}`;

	const searchableDocumentConversationId = await requireCreatedConversation(
		await requestConversationCreate(),
	);
	const searchableDocumentTurns = await verifySearchableDocumentTools(
		searchableDocumentConversationId,
	);
	fullSuiteEvidence += `; searchable-document conversation ${searchableDocumentConversationId}; runs ${searchableDocumentTurns.inventoryRunId}, ${searchableDocumentTurns.contentRunId}`;
}

console.log(
	`agent live smoke passed: suite=${suite}; conversation ${conversationId}; runs ${firstTurn.runId}, ${secondTurn.runId}, ${artifactTurn.runId}${fullSuiteEvidence}`,
);

function requestConversationCreate(): Promise<Response> {
	return fetch(`${baseUrl}/v1/conversations`, {
		method: "POST",
		headers: headers(),
		body: "{}",
		signal: AbortSignal.timeout(turnTimeoutMs),
	});
}

async function requireCreatedConversation(response: Response): Promise<string> {
	if (response.status !== 201) {
		throw new Error(
			`expected conversation create 201, got ${response.status}: ${await response.text()}`,
		);
	}

	const { conversationId } = (await response.json()) as {
		conversationId?: string;
	};
	if (!conversationId) {
		throw new Error(
			"conversation create response did not include conversationId",
		);
	}
	return conversationId;
}

async function verifyArtifact(
	conversationId: string,
	expectedContent: string,
): Promise<void> {
	const listResponse = await fetch(
		`${baseUrl}/v1/conversations/${conversationId}/artifacts`,
		{
			headers: headers(),
			signal: AbortSignal.timeout(turnTimeoutMs),
		},
	);
	if (listResponse.status !== 200) {
		throw new Error(
			`expected artifact list 200, got ${listResponse.status}: ${await listResponse.text()}`,
		);
	}
	const listBody = (await listResponse.json()) as { artifacts?: unknown };
	if (!Array.isArray(listBody.artifacts) || listBody.artifacts.length !== 1) {
		throw new Error("artifact list did not contain exactly one artifact");
	}
	const artifact = listBody.artifacts[0] as ArtifactMetadata;
	if (artifact.path !== CORE_ARTIFACT_PATH) {
		throw new Error(
			`artifact list path was ${String(artifact.path)}, expected ${CORE_ARTIFACT_PATH}`,
		);
	}
	if (typeof artifact.artifactId !== "string" || !artifact.artifactId) {
		throw new Error("artifact list did not include a valid artifactId");
	}
	if (!Number.isInteger(artifact.sizeBytes) || Number(artifact.sizeBytes) < 0) {
		throw new Error("artifact list did not include a valid sizeBytes");
	}

	const urlResponse = await fetch(
		`${baseUrl}/v1/conversations/${conversationId}/artifacts/${encodeURIComponent(artifact.artifactId)}/download-url`,
		{
			headers: headers(),
			redirect: "manual",
			signal: AbortSignal.timeout(turnTimeoutMs),
		},
	);
	if (urlResponse.status !== 200) {
		throw new Error(
			`expected artifact download URL 200, got ${urlResponse.status}: ${await urlResponse.text()}`,
		);
	}
	const urlBody = (await urlResponse.json()) as { downloadUrl?: unknown };
	if (typeof urlBody.downloadUrl !== "string" || !urlBody.downloadUrl) {
		throw new Error(
			"artifact download response did not include string downloadUrl",
		);
	}

	const downloadResponse = await fetch(urlBody.downloadUrl, {
		signal: AbortSignal.timeout(turnTimeoutMs),
	});
	if (!downloadResponse.ok) {
		throw new Error(
			`expected signed artifact download 2xx, got ${downloadResponse.status}: ${await downloadResponse.text()}`,
		);
	}
	if (
		!/^attachment(?:;|$)/i.test(
			downloadResponse.headers.get("content-disposition")?.trim() ?? "",
		)
	) {
		throw new Error("signed artifact download was not an attachment");
	}
	const downloadedBytes = new Uint8Array(await downloadResponse.arrayBuffer());
	if (artifact.sizeBytes !== downloadedBytes.byteLength) {
		throw new Error(
			`artifact list size ${String(artifact.sizeBytes)} did not match downloaded object size ${downloadedBytes.byteLength}`,
		);
	}
	if (!matchesRequestedContent(downloadedBytes, expectedContent)) {
		throw new Error(
			"downloaded artifact bytes did not match requested content",
		);
	}
}

async function verifySearchableDocumentTools(conversationId: string): Promise<{
	inventoryRunId: string;
	contentRunId: string;
}> {
	const inventoryTurn = await sendTurn(
		conversationId,
		[
			"Run the local seeded searchable-document inventory check.",
			"Use ListDocuments exactly once with limit=20 and no cursor to inventory all searchable documents in this Conversation's scope.",
			"Do not use any other tool.",
			"Reply with exactly DOCUMENT_COUNT=<the exact total returned by ListDocuments> and nothing else.",
		].join("\n"),
	);
	const expectedInventoryText = `DOCUMENT_COUNT=${FIXTURE_SEARCHABLE_DOCUMENT_COUNT}`;
	if (inventoryTurn.text !== expectedInventoryText) {
		throw new Error(
			`searchable-document inventory did not report the fixture-exact count: ${inventoryTurn.text}`,
		);
	}
	requireToolHistory(inventoryTurn, "searchable-document inventory", [
		{
			tool: "ListDocuments",
			arguments: { limit: 20, cursorProvided: false },
			result: {
				total: FIXTURE_SEARCHABLE_DOCUMENT_COUNT,
				returnedCount: FIXTURE_SEARCHABLE_DOCUMENT_COUNT,
				hasMore: false,
				documents: [
					{ title: "Intro to Machine Learning" },
					{ title: FIXTURE_SEARCHABLE_DOCUMENT_TITLE },
				],
			},
		},
	]);

	const contentTurn = await sendTurn(
		conversationId,
		[
			"Run the local seeded searchable-document search, load, and read check.",
			"Use SearchDocuments exactly once with this exact query: personal knowledge base",
			"Use LoadDocuments exactly once to load the matching searchable document into the docs cache.",
			"Use Read exactly once with the cache path returned by LoadDocuments, offset=1, and limit=1 to read the first markdown heading from that file.",
			"Do not use any other tool.",
			"Reply with exactly these two lines, replacing both placeholders:",
			"DOCUMENT_TITLE=<the matching searchable document title>",
			"FIRST_HEADING=<the first markdown heading, including its leading #>",
		].join("\n"),
	);
	const expectedContentText = `DOCUMENT_TITLE=${FIXTURE_SEARCHABLE_DOCUMENT_TITLE}\nFIRST_HEADING=${FIXTURE_SEARCHABLE_DOCUMENT_HEADING}`;
	if (contentTurn.text !== expectedContentText) {
		throw new Error(
			`searchable-document content check did not report the fixture-exact title and heading: ${contentTurn.text}`,
		);
	}
	requireToolHistory(contentTurn, "searchable-document content", [
		{
			tool: "SearchDocuments",
			arguments: { query: "personal knowledge base" },
			result: {
				passages: [
					{
						title: FIXTURE_SEARCHABLE_DOCUMENT_TITLE,
						snippet:
							"MyMemo is a personal knowledge base that answers questions by searching your documents.",
					},
				],
			},
		},
		{
			tool: "LoadDocuments",
			arguments: { requestedCount: 1 },
			result: {
				loadedCount: 1,
				loaded: [{ title: FIXTURE_SEARCHABLE_DOCUMENT_TITLE }],
				failedCount: 0,
			},
		},
		{
			tool: "Read",
			arguments: {
				path: ".mymemo/docs/doc-mymemo-overview.md",
				offset: 1,
				limit: 1,
			},
			result: {
				path: ".mymemo/docs/doc-mymemo-overview.md",
				content: FIXTURE_SEARCHABLE_DOCUMENT_HEADING,
				startLine: 1,
				linesRead: 1,
				truncated: true,
			},
		},
	]);

	return {
		inventoryRunId: inventoryTurn.runId,
		contentRunId: contentTurn.runId,
	};
}

interface ExpectedToolExchange {
	tool: PublicToolName;
	arguments: Record<string, unknown>;
	result: Record<string, unknown>;
}

function requireToolHistory(
	turn: TurnResult,
	label: string,
	expected: ExpectedToolExchange[],
): void {
	const actualTools: string[] = [];
	let valid = turn.toolFrames.length === expected.length * 4;
	for (const [index, exchange] of expected.entries()) {
		const [start, args, end, result] = turn.toolFrames.slice(
			index * 4,
			index * 4 + 4,
		);
		if (
			!start ||
			!args ||
			!end ||
			!result ||
			start.event !== "TOOL_CALL_START" ||
			args.event !== "TOOL_CALL_ARGS" ||
			end.event !== "TOOL_CALL_END" ||
			result.event !== "TOOL_CALL_RESULT"
		) {
			valid = false;
			continue;
		}
		const startData = recordData(start.data);
		const argsData = recordData(args.data);
		const endData = recordData(end.data);
		const resultData = recordData(result.data);
		const toolCallId = startData.toolCallId;
		if (typeof startData.toolCallName === "string") {
			actualTools.push(startData.toolCallName);
		}
		let projectedArguments: unknown;
		let projectedResult: unknown;
		try {
			projectedArguments = JSON.parse(String(argsData.delta));
			projectedResult = JSON.parse(String(resultData.content));
		} catch {
			valid = false;
		}
		valid &&=
			typeof toolCallId === "string" &&
			startData.toolCallName === exchange.tool &&
			typeof startData.parentMessageId === "string" &&
			argsData.toolCallId === toolCallId &&
			endData.toolCallId === toolCallId &&
			resultData.toolCallId === toolCallId &&
			typeof resultData.messageId === "string" &&
			resultData.role === "tool" &&
			isDeepStrictEqual(projectedArguments, exchange.arguments) &&
			isDeepStrictEqual(projectedResult, exchange.result);
	}
	if (!valid) {
		throw new Error(
			`${label} Run did not record the required Tool invocations and successful results: expected ${expected.map(({ tool }) => tool).join(", ")}; got ${actualTools.join(", ") || "none"}`,
		);
	}
}

function matchesRequestedContent(
	actual: Uint8Array,
	expectedContent: string,
): boolean {
	const expected = new TextEncoder().encode(expectedContent);
	const allowedLength =
		actual.byteLength === expected.byteLength ||
		(actual.byteLength === expected.byteLength + 1 &&
			actual.at(-1) === "\n".charCodeAt(0));
	if (!allowedLength) return false;
	return expected.every((byte, index) => actual[index] === byte);
}

async function verifyRunningRunCancellation(
	conversationId: string,
): Promise<{ runId: string }> {
	const runId = randomUUID();
	const response = await fetch(
		`${baseUrl}/v1/conversations/${conversationId}/runs`,
		{
			method: "POST",
			headers: headers(),
			body: JSON.stringify({
				threadId: conversationId,
				runId,
				messages: [
					{
						id: randomUUID(),
						role: "user",
						content: [
							"Run the local full-suite cancellation check.",
							"Immediately use the Bash tool to run exactly this command: sleep 120",
							"Do not use any other tool.",
							"Do not reply until the command finishes.",
						].join("\n"),
					},
				],
				tools: [],
				context: [],
			}),
			signal: AbortSignal.timeout(turnTimeoutMs),
		},
	);
	if (!response.ok) {
		throw new Error(
			`expected interrupt-check event stream 2xx, got ${response.status}: ${await response.text()}`,
		);
	}
	if (!response.headers.get("content-type")?.includes("text/event-stream")) {
		throw new Error("interrupt-check event response was not an SSE stream");
	}

	const frames: SSEFrame[] = [];
	const client = createClientContractFixture();
	let interruptSent = false;

	await readSSEIncrementally(response, async (frame) => {
		if (frame.event === "ping") return;
		if (!INTERRUPTED_TURN_EVENT_TYPES.has(frame.event)) {
			throw new Error(
				`interrupted event stream included unexpected ${frame.event}`,
			);
		}
		frames.push(frame);
		client.receive({ ...frame, data: parseFrameData(frame) });

		if (frame.event === "RUN_STARTED") {
			if (stringField(frame, "runId") !== runId) {
				throw new Error("interrupt-check stream echoed the wrong Run id");
			}
			if (stringField(frame, "threadId") !== conversationId) {
				throw new Error(
					"interrupt-check stream echoed the wrong Conversation id",
				);
			}
		}
		if (frame.event === "TOOL_CALL_START" && !interruptSent) {
			if (!frames.some((candidate) => candidate.event === "RUN_STARTED")) {
				throw new Error("Tool invocation arrived before RUN_STARTED");
			}
			const tool = stringField(frame, "toolCallName");
			if (tool !== "Bash") {
				throw new Error(
					`interrupt-check first Tool invocation was ${tool}, expected Bash`,
				);
			}
			interruptSent = true;
			await requestRunningRunCancellation(conversationId, runId);
		}
	});

	if (!interruptSent) {
		throw new Error(
			"interrupted event stream ended before the first Tool invocation",
		);
	}
	const events = frames.map((frame) => frame.event);
	const runIndex = events.indexOf("RUN_STARTED");
	const toolUseIndex = events.indexOf("TOOL_CALL_START");
	if (runIndex < 0 || toolUseIndex < 0 || runIndex >= toolUseIndex) {
		throw new Error(
			`interrupted event stream did not identify the Run before the Tool invocation: ${events.join(", ")}`,
		);
	}
	if (
		events.at(-1) !== "RUN_CANCELLED" ||
		events.filter((event) => event === "RUN_CANCELLED").length !== 1
	) {
		throw new Error(
			`interrupted event stream did not end in one canceled outcome: ${events.join(", ")}`,
		);
	}

	const snapshot = client.snapshot();
	if (snapshot.terminal !== "canceled") {
		throw new Error("client fixture did not observe the canceled outcome");
	}
	if (snapshot.messages.some((message) => message.provisional)) {
		throw new Error(
			"client fixture retained provisional Assistant text after cancellation",
		);
	}
	if (
		!snapshot.toolEvents.some(
			(event) => event.kind === "tool_call_start" && event.tool === "Bash",
		)
	) {
		throw new Error("client fixture did not retain the Bash Tool invocation");
	}

	await replayTurn({
		conversationId,
		runId,
		messages: snapshot.messages,
		toolFrames: durableToolFrames(frames),
		terminal: "canceled",
	});
	return { runId };
}

async function requestRunningRunCancellation(
	conversationId: string,
	runId: string,
): Promise<void> {
	const response = await fetch(
		`${baseUrl}/v1/conversations/${conversationId}/runs/${runId}/cancel`,
		{
			method: "POST",
			headers: headers(),
			signal: AbortSignal.timeout(turnTimeoutMs),
		},
	);
	const rawBody = await response.text();
	if (response.status !== 202) {
		throw new Error(
			`expected running Run cancellation 202, got ${response.status}: ${rawBody}`,
		);
	}

	let body: unknown;
	try {
		body = JSON.parse(rawBody);
	} catch {
		throw new Error("running Run cancellation response was not JSON");
	}
	if (
		typeof body !== "object" ||
		body === null ||
		Array.isArray(body) ||
		Object.keys(body).sort().join(",") !== "runId,status" ||
		(body as Record<string, unknown>).runId !== runId ||
		(body as Record<string, unknown>).status !== "cancel_requested"
	) {
		throw new Error(
			"running Run cancellation response was not the accepted cancel_requested shape",
		);
	}
}

async function sendTurn(
	conversationId: string,
	message: string,
): Promise<TurnResult> {
	const runId = randomUUID();
	const response = await fetch(
		`${baseUrl}/v1/conversations/${conversationId}/runs`,
		{
			method: "POST",
			headers: headers(),
			body: JSON.stringify({
				threadId: conversationId,
				runId,
				messages: [{ id: randomUUID(), role: "user", content: message }],
				tools: [],
				context: [],
			}),
			signal: AbortSignal.timeout(turnTimeoutMs),
		},
	);
	const body = await response.text();
	if (!response.ok) {
		throw new Error(
			`expected event stream 2xx, got ${response.status}: ${body}`,
		);
	}
	if (!response.headers.get("content-type")?.includes("text/event-stream")) {
		throw new Error("event response was not an SSE stream");
	}

	const frames = parseSSE(body).filter((frame) => frame.event !== "ping");
	const events = frames.map((frame) => frame.event);
	const unexpected = events.find((event) => !TURN_EVENT_TYPES.has(event));
	if (unexpected)
		throw new Error(`event stream included unexpected ${unexpected}`);
	if (events.at(-1) !== "RUN_FINISHED") {
		throw new Error(
			`event stream did not end in RUN_FINISHED: ${events.join(", ")}`,
		);
	}
	const runIndex = events.indexOf("RUN_STARTED");
	const firstTextIndex = events.indexOf("TEXT_MESSAGE_START");
	if (runIndex < 0 || firstTextIndex < 0 || runIndex >= firstTextIndex) {
		throw new Error(
			`event stream did not identify the Run before text: ${events.join(", ")}`,
		);
	}
	const startFrames = frames.filter(
		(frame) => frame.event === "TEXT_MESSAGE_START",
	);
	const endFrames = frames.filter(
		(frame) => frame.event === "TEXT_MESSAGE_END",
	);
	if (startFrames.length !== 1 || endFrames.length !== 1) {
		throw new Error(
			"event stream did not contain exactly one complete Assistant message",
		);
	}
	if (
		stringField(startFrames[0], "messageId") !==
		stringField(endFrames[0], "messageId")
	) {
		throw new Error("Assistant message identity changed before completion");
	}

	const client = createClientContractFixture();
	for (const frame of frames) {
		client.receive({ ...frame, data: parseFrameData(frame) });
	}
	const snapshot = client.snapshot();
	if (snapshot.terminal !== "done") {
		throw new Error("client fixture did not observe the done outcome");
	}
	if (snapshot.messages.some((message) => message.provisional)) {
		throw new Error("client fixture retained provisional Assistant text");
	}
	if (snapshot.messages.length !== 1) {
		throw new Error(
			"client fixture did not retain exactly one committed message",
		);
	}

	const startedFrame = frames.find((frame) => frame.event === "RUN_STARTED");
	const echoedConversationId = stringField(startedFrame, "threadId");
	if (echoedConversationId !== conversationId) {
		throw new Error(
			`event stream echoed conversation ${echoedConversationId}, expected ${conversationId}`,
		);
	}
	if (stringField(startedFrame, "runId") !== runId) {
		throw new Error("event stream echoed the wrong Run id");
	}
	const text = snapshot.messages.map((message) => message.text).join("");
	if (!text.trim()) throw new Error("event stream contained no assistant text");
	await replayTurn({
		conversationId,
		runId,
		messages: snapshot.messages,
		toolFrames: durableToolFrames(frames),
	});
	return { runId, text, toolFrames: durableToolFrames(frames) };
}

async function replayTurn(expectation: ReplayExpectation): Promise<void> {
	const expectedTerminal = expectation.terminal ?? "done";
	const expectedTerminalEvent = {
		done: "RUN_FINISHED",
		canceled: "RUN_CANCELLED",
		error: "RUN_ERROR",
	}[expectedTerminal];
	const response = await fetch(
		`${baseUrl}/v1/conversations/${expectation.conversationId}/runs/${expectation.runId}/events`,
		{
			headers: headers(),
			signal: AbortSignal.timeout(turnTimeoutMs),
		},
	);
	const body = await response.text();
	if (!response.ok) {
		throw new Error(
			`expected reconnect stream 2xx, got ${response.status}: ${body}`,
		);
	}
	if (!response.headers.get("content-type")?.includes("text/event-stream")) {
		throw new Error("reconnect response was not an SSE stream");
	}

	const frames = parseSSE(body).filter((frame) => frame.event !== "ping");
	const replayedEvents = frames.map((frame) => frame.event);
	if (replayedEvents[0] !== "RUN_STARTED") {
		throw new Error("reconnect did not rebuild the Run from RUN_STARTED");
	}
	if (replayedEvents.at(-1) !== expectedTerminalEvent) {
		throw new Error(
			`durable reconnect did not end in ${expectedTerminalEvent}: ${replayedEvents.join(", ")}`,
		);
	}
	const replayedTerminals = replayedEvents.filter((event) =>
		["RUN_FINISHED", "RUN_CANCELLED", "RUN_ERROR"].includes(event),
	);
	if (
		replayedTerminals.length !== 1 ||
		replayedTerminals[0] !== expectedTerminalEvent
	) {
		throw new Error(
			`durable reconnect did not contain exactly one ${expectedTerminal} outcome: ${replayedEvents.join(", ")}`,
		);
	}

	const client = createClientContractFixture();
	for (const frame of frames) {
		client.receive({ ...frame, data: parseFrameData(frame) });
	}
	const snapshot = client.snapshot();
	if (snapshot.terminal !== expectedTerminal) {
		throw new Error(
			`reconnected client fixture did not observe ${expectedTerminal}`,
		);
	}
	if (!isDeepStrictEqual(snapshot.messages, expectation.messages)) {
		throw new Error(
			"durable reconnect did not replay the exact committed messages",
		);
	}
	// Tool lifecycle events are durable run events too: reconnect replays the
	// exact correlated frames the original stream showed, in order (ADR-0012).
	if (!isDeepStrictEqual(durableToolFrames(frames), expectation.toolFrames)) {
		throw new Error("durable reconnect did not replay the exact Tool events");
	}
}

function durableToolFrames(frames: SSEFrame[]): DurableToolFrame[] {
	return frames.flatMap((frame) => {
		if (
			frame.event !== "TOOL_CALL_START" &&
			frame.event !== "TOOL_CALL_ARGS" &&
			frame.event !== "TOOL_CALL_END" &&
			frame.event !== "TOOL_CALL_RESULT" &&
			frame.event !== "CUSTOM"
		) {
			return [];
		}
		return [
			{
				event: frame.event,
				data: parseFrameData(frame),
			},
		];
	});
}

function recordData(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: {};
}

async function readSSEIncrementally(
	response: Response,
	onFrame: (frame: SSEFrame) => Promise<void>,
): Promise<void> {
	if (!response.body) throw new Error("event response had no body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	const dispatch = async (block: string): Promise<void> => {
		for (const frame of parseSSE(block)) await onFrame(frame);
	};

	while (true) {
		const { done, value } = await reader.read();
		if (value) buffer += decoder.decode(value, { stream: true });

		let boundary = /\r?\n\r?\n/.exec(buffer);
		while (boundary?.index !== undefined) {
			const block = buffer.slice(0, boundary.index);
			buffer = buffer.slice(boundary.index + boundary[0].length);
			await dispatch(block);
			boundary = /\r?\n\r?\n/.exec(buffer);
		}
		if (done) break;
	}

	buffer += decoder.decode();
	if (buffer.trim()) await dispatch(buffer);
}

function parseSSE(raw: string): SSEFrame[] {
	const frames: SSEFrame[] = [];
	for (const block of raw.replaceAll("\r\n", "\n").split("\n\n")) {
		let event = "";
		const data: string[] = [];
		for (const line of block.split("\n")) {
			if (line.startsWith("id:")) {
				throw new Error("event stream carried an unexpected SSE id");
			}
			if (line.startsWith("event:")) {
				event = line.slice("event:".length).trim();
			} else if (line.startsWith("data:")) {
				data.push(line.slice("data:".length).trimStart());
			}
		}
		const frameData = data.join("\n");
		if (!event && frameData) {
			try {
				const parsed = JSON.parse(frameData) as { type?: unknown };
				if (typeof parsed.type === "string") event = parsed.type;
			} catch {
				// parseFrameData reports malformed JSON with event context.
			}
		}
		if (event) frames.push({ event, data: frameData });
	}
	return frames;
}

function stringField(frame: SSEFrame | undefined, field: string): string {
	if (!frame)
		throw new Error(`event stream did not include the ${field} frame`);
	const value = parseFrameData(frame);
	if (
		typeof value !== "object" ||
		value === null ||
		typeof (value as Record<string, unknown>)[field] !== "string"
	) {
		throw new Error(`${frame.event} frame did not contain string ${field}`);
	}
	return (value as Record<string, string>)[field] as string;
}

function parseFrameData(frame: SSEFrame): unknown {
	try {
		return JSON.parse(frame.data);
	} catch {
		throw new Error(`${frame.event} frame did not contain JSON data`);
	}
}

type SmokeSuite = "core" | "full";

function parseSuite(value: string | undefined): SmokeSuite {
	if (value === undefined || value === "core") return "core";
	if (value === "full") return "full";
	throw new Error("AGENT_SMOKE_SUITE must be core or full");
}

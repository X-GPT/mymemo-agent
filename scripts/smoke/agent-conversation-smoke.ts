#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import {
	type ClientContractMessage,
	createClientContractFixture,
} from "./client-contract";

const baseUrl = requiredEnv("AGENT_SMOKE_BASE_URL").replace(/\/+$/, "");
const memberCode = Bun.env.AGENT_SMOKE_MEMBER_CODE || "agent-smoke-member";
const partnerCode = Bun.env.AGENT_SMOKE_PARTNER_CODE || "agent-smoke-partner";
const expectGateClosed = Bun.env.AGENT_SMOKE_EXPECT_GATE_CLOSED !== "false";
const previewMode = parsePreviewMode(Bun.env.AGENT_SMOKE_PREVIEW_MODE);
const rawTurnTimeout = Bun.env.AGENT_SMOKE_TURN_TIMEOUT_MS;
const turnTimeoutMs =
	rawTurnTimeout === undefined ? 180_000 : Number(rawTurnTimeout);
if (!Number.isInteger(turnTimeoutMs) || turnTimeoutMs <= 0) {
	throw new Error("AGENT_SMOKE_TURN_TIMEOUT_MS must be a positive integer");
}

const TURN_EVENT_TYPES: ReadonlySet<string> = new Set([
	"conversation_id",
	"run_id",
	"text_delta",
	"text_commit",
	"done",
]);

interface SSEFrame {
	id?: string;
	event: string;
	data: string;
}

interface TurnResult {
	runId: string;
	text: string;
}

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

const create = await fetch(`${baseUrl}/v1/conversations`, {
	method: "POST",
	headers: headers(),
	body: "{}",
	signal: AbortSignal.timeout(turnTimeoutMs),
});

if (expectGateClosed) {
	if (create.status !== 403) {
		throw new Error(
			`expected Statsig gate to be closed with 403, got ${create.status}`,
		);
	}
	console.log("agent smoke passed: Statsig gate is closed by default");
	process.exit(0);
}

if (create.status !== 201) {
	throw new Error(
		`expected conversation create 201, got ${create.status}: ${await create.text()}`,
	);
}

const { conversationId } = (await create.json()) as { conversationId?: string };
if (!conversationId) {
	throw new Error(
		"conversation create response did not include conversationId",
	);
}

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

console.log(
	`agent live smoke passed: preview=${previewMode}; conversation ${conversationId}; runs ${firstTurn.runId}, ${secondTurn.runId}`,
);

async function sendTurn(
	conversationId: string,
	message: string,
): Promise<TurnResult> {
	const response = await fetch(
		`${baseUrl}/v1/conversations/${conversationId}/events`,
		{
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ type: "user.message", text: message }),
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
	if (events.at(-1) !== "done") {
		throw new Error(`event stream did not end in done: ${events.join(", ")}`);
	}
	const conversationIndex = events.indexOf("conversation_id");
	const runIndex = events.indexOf("run_id");
	const firstTextIndex = events.findIndex(
		(event) => event === "text_delta" || event === "text_commit",
	);
	if (
		conversationIndex < 0 ||
		runIndex < 0 ||
		firstTextIndex < 0 ||
		conversationIndex >= runIndex ||
		runIndex >= firstTextIndex
	) {
		throw new Error(
			`event stream did not identify the Conversation and Run before text: ${events.join(", ")}`,
		);
	}
	const previewFrames = frames.filter((frame) => frame.event === "text_delta");
	const commitFrames = frames.filter((frame) => frame.event === "text_commit");
	if (commitFrames.length !== 1) {
		throw new Error(
			`event stream contained ${commitFrames.length} commits; expected exactly one provider-complete Assistant message`,
		);
	}
	if (previewMode === "required" && previewFrames.length === 0) {
		throw new Error("event stream contained no required Live preview");
	}
	if (previewMode === "forbidden" && previewFrames.length > 0) {
		throw new Error(
			"Redis-disabled stream unexpectedly contained Live preview",
		);
	}
	if (previewMode === "required") {
		const firstPreviewIndex = frames.findIndex(
			(frame) => frame.event === "text_delta",
		);
		const firstCommitIndex = frames.findIndex(
			(frame) => frame.event === "text_commit",
		);
		if (firstPreviewIndex < 0 || firstPreviewIndex >= firstCommitIndex) {
			throw new Error("Live preview did not arrive before its durable commit");
		}
		const commitMessageId = stringField(commitFrames[0], "messageId");
		if (
			previewFrames.some(
				(frame) => stringField(frame, "messageId") !== commitMessageId,
			)
		) {
			throw new Error("Live preview did not belong to the committed message");
		}
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

	const echoedConversationId = stringField(
		frames.find((frame) => frame.event === "conversation_id"),
		"conversationId",
	);
	if (echoedConversationId !== conversationId) {
		throw new Error(
			`event stream echoed conversation ${echoedConversationId}, expected ${conversationId}`,
		);
	}
	const runId = stringField(
		frames.find((frame) => frame.event === "run_id"),
		"runId",
	);
	const runCursor = frames.find((frame) => frame.event === "run_id")?.id;
	if (!runCursor)
		throw new Error("run_id frame did not carry a durable cursor");
	const text = snapshot.messages.map((message) => message.text).join("");
	if (!text.trim()) throw new Error("event stream contained no assistant text");
	await replayTurn(conversationId, runId, runCursor, snapshot.messages);
	return { runId, text };
}

async function replayTurn(
	conversationId: string,
	runId: string,
	afterCursor: string,
	expectedMessages: ClientContractMessage[],
): Promise<void> {
	const response = await fetch(
		`${baseUrl}/v1/conversations/${conversationId}/runs/${runId}/events`,
		{
			headers: { ...headers(), "Last-Event-ID": afterCursor },
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
	if (
		replayedEvents.some((event) =>
			["conversation_id", "run_id", "text_delta"].includes(event),
		)
	) {
		throw new Error(
			`durable reconnect attempted to replay non-durable frames: ${replayedEvents.join(", ")}`,
		);
	}
	if (replayedEvents.at(-1) !== "done") {
		throw new Error(
			`durable reconnect did not end in done: ${replayedEvents.join(", ")}`,
		);
	}

	const client = createClientContractFixture();
	for (const frame of frames) {
		client.receive({ ...frame, data: parseFrameData(frame) });
	}
	const snapshot = client.snapshot();
	if (snapshot.terminal !== "done") {
		throw new Error("reconnected client fixture did not observe done");
	}
	if (JSON.stringify(snapshot.messages) !== JSON.stringify(expectedMessages)) {
		throw new Error(
			"durable reconnect did not replay the exact committed messages",
		);
	}
}

function parseSSE(raw: string): SSEFrame[] {
	const frames: SSEFrame[] = [];
	for (const block of raw.replaceAll("\r\n", "\n").split("\n\n")) {
		let id: string | undefined;
		let event = "";
		const data: string[] = [];
		for (const line of block.split("\n")) {
			if (line.startsWith("id:")) {
				id = line.slice("id:".length).trim();
			} else if (line.startsWith("event:")) {
				event = line.slice("event:".length).trim();
			} else if (line.startsWith("data:")) {
				data.push(line.slice("data:".length).trimStart());
			}
		}
		if (event) frames.push({ id, event, data: data.join("\n") });
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

type PreviewMode = "optional" | "required" | "forbidden";

function parsePreviewMode(value: string | undefined): PreviewMode {
	if (value === undefined || value === "optional") return "optional";
	if (value === "required" || value === "forbidden") return value;
	throw new Error(
		"AGENT_SMOKE_PREVIEW_MODE must be optional, required, or forbidden",
	);
}

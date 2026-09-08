import assert from "node:assert/strict";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { fromIni } from "@aws-sdk/credential-providers";
import type { Artifact } from "../src/artifacts";
import type { Turn } from "../src/history";

// A real business session through mymemo-service; never fabricate identity headers.
const base = process.env.BFF_URL ?? "";
const token = process.env.BFF_TOKEN;
const bucket = process.env.WORKSPACE_BUCKET;
assert(
	base && token && bucket,
	"BFF_URL, BFF_TOKEN and WORKSPACE_BUCKET are required",
);
assert(new URL(base).protocol === "https:", "Use the deployed HTTPS BFF");
const s3 = new S3Client({
	region: "us-west-2",
	credentials: fromIni({ profile: "mymemo" }),
});
async function call(path: string, method = "GET", body?: object, status = 200) {
	const response = await fetch(
		`${base.replace(/\/$/, "")}/agent/conversations${path}`,
		{
			method,
			redirect: "error",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(840_000),
		},
	);
	assert.equal(
		response.status,
		status,
		`${method} ${path}: ${response.status}`,
	);
	return response;
}
const { conversationId: id } = (await (
	await call("", "POST", {}, 201)
).json()) as { conversationId: string };
const marker = crypto.randomUUID();
const fileMarker = crypto.randomUUID();
console.log(
	JSON.stringify({ conversationId: id, startedAt: new Date().toISOString() }),
);
async function archive() {
	const result = await s3.send(
		new HeadObjectCommand({
			Bucket: bucket,
			Key: `_workspace/${id}/workspace.tgz`,
		}),
	);
	return result.ETag;
}
async function turn(text: string, during?: () => Promise<void>) {
	const response = await call(`/${id}/messages`, "POST", {
		text,
		requestId: crypto.randomUUID(),
	});
	assert.equal(response.headers.get("x-vercel-ai-ui-message-stream"), "v1");
	assert(response.body);
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const first = await reader.read();
	assert(!first.done, "No first stream chunk");
	let wire = decoder.decode(first.value, { stream: true });
	await during?.();
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) break;
		wire += decoder.decode(chunk.value, { stream: true });
	}
	wire += decoder.decode();
	assert(wire.includes("data: [DONE]"), "Stream truncated");
	const parts = wire
		.split("\n")
		.filter((line) => line.startsWith("data: {"))
		.map((line) => JSON.parse(line.slice(6)));
	console.log(
		JSON.stringify({
			conversationId: id,
			turnId: parts.find((p) => p.type === "start")?.messageMetadata.turnId,
			status: parts.find((p) => p.type === "message-metadata")?.messageMetadata,
		}),
	);
	return parts;
}
try {
	const first = await turn(
		`Remember the secret word ${marker} for the next Turn. Use Write to create artifacts/gate.txt containing ${fileMarker}. Use Bash to append a newline to artifacts/gate.txt and sleep 8. Present a bar chart with values A=1 and B=2 using PresentUI, then reply READY.`,
		async () => {
			await call(
				`/${id}/messages`,
				"POST",
				{ text: "overlap", requestId: crypto.randomUUID() },
				409,
			);
			const { messages } = (await (await call(`/${id}/messages`)).json()) as {
				messages: Array<Turn["user"] | NonNullable<Turn["assistant"]>>;
			};
			assert.equal(messages.length, 1);
			assert.equal(messages[0]?.role, "user");
			assert.equal(messages[0]?.metadata.status, "processing");
		},
	);
	assert(!first.some((p) => p.type === "error"));
	for (const type of ["text-delta", "data-artifacts", "data-generative-ui"])
		assert(
			first.some((p) => p.type === type),
			`Missing ${type}`,
		);
	for (const toolName of ["Write", "Bash"])
		assert(
			first.some((p) => p.toolName === toolName),
			`Missing ${toolName}`,
		);
	const { messages } = (await (await call(`/${id}/messages`)).json()) as {
		messages: Array<Turn["user"] | NonNullable<Turn["assistant"]>>;
	};
	assert.equal(messages.length, 2);
	assert(messages.every((m) => m.metadata.status === "done"));
	assert(
		messages.some((m) => m.parts.some((p) => p.type === "data-generative-ui")),
	);
	const { artifacts } = (await (await call(`/${id}/artifacts`)).json()) as {
		artifacts: Artifact[];
	};
	const artifact = artifacts.find((a) => a.path === "gate.txt");
	assert(artifact);
	const { downloadUrl } = (await (
		await call(`/${id}/artifacts/${artifact.artifactId}/download-url`)
	).json()) as { downloadUrl: string };
	const download = await fetch(downloadUrl);
	assert.equal(download.status, 200);
	assert((await download.text()).includes(fileMarker));
	const previous = await archive();
	const second = await turn(
		"Without reading any file first, reply with the secret word I gave you in the previous Turn. Then use Bash to cat artifacts/gate.txt and append 'Turn 2' to it.",
	);
	assert(!second.some((p) => p.type === "error"));
	const firstTool = second.findIndex((p) => p.type === "tool-input-start");
	assert(firstTool >= 0, "Turn 2 must use Bash");
	assert(
		second
			.slice(0, firstTool)
			.filter((p) => p.type === "text-delta")
			.map((p) => p.delta)
			.join("")
			.includes(marker),
		"Transcript recall failed",
	);
	const bash = second.find(
		(p) => p.type === "tool-input-available" && p.toolName === "Bash",
	);
	assert(bash, "Turn 2 Bash call missing");
	assert(
		second.some(
			(p) =>
				p.type === "tool-output-available" &&
				p.toolCallId === bash.toolCallId &&
				p.output.value.includes(fileMarker),
		),
		"Turn 2 Bash did not read the persisted file marker",
	);
	assert.notEqual(
		await archive(),
		previous,
		"Workspace tarball did not update",
	);
	console.log(
		"PASS: BFF streaming, Write/Bash artifact download, active-send 409, whole-reply/chart history, transcript recall and tarball update",
	);
} finally {
	const response = await fetch(
		`${base.replace(/\/$/, "")}/agent/conversations/${id}`,
		{
			method: "DELETE",
			redirect: "error",
			headers: { authorization: `Bearer ${token}` },
		},
	);
	console.log(
		JSON.stringify({ conversationId: id, deleteStatus: response.status }),
	);
	assert(
		[204, 404].includes(response.status),
		`Retry fixture DELETE after processing expires: ${id}`,
	);
	s3.destroy();
}

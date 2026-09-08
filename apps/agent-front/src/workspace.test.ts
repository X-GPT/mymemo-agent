import { expect, spyOn, test } from "bun:test";
import {
	BedrockAgentCoreClient,
	type CodeInterpreterResult,
	InvokeCodeInterpreterCommand,
	StartCodeInterpreterSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Workspace, WorkspaceTooLarge } from "./workspace";

const MiB = 1024 * 1024;
function harness(size = 25 * MiB) {
	const client = new BedrockAgentCoreClient({ region: "us-west-2" });
	const s3 = new S3Client({ region: "us-west-2" });
	const workspace = new Workspace(client, "interpreter", s3, "bucket");
	let previous: Uint8Array | undefined;
	const calls: Array<{ name: string; input: unknown }> = [];
	const send = spyOn(client, "send").mockImplementation(async (command) => {
		calls.push({ name: command.constructor.name, input: command.input });
		if (command instanceof StartCodeInterpreterSessionCommand)
			return { sessionId: "session" };
		if (!(command instanceof InvokeCodeInterpreterCommand)) return {};
		let result: CodeInterpreterResult = {
			content: [],
			structuredContent: { stdout: String(size), exitCode: 0 },
		};
		if (command.input.name === "readFiles")
			result = {
				content: command.input.arguments?.paths?.map((path) => {
					const index = Number(path.slice(-2));
					return {
						type: "resource",
						resource: {
							type: "blob",
							blob: new Uint8Array(
								Math.min(8 * MiB, size - index * 8 * MiB),
							).fill(index),
						},
					};
				}),
			};
		return {
			stream: (async function* () {
				yield { result };
			})(),
		};
	});
	const objects = spyOn(s3, "send").mockImplementation(async (command) => {
		calls.push({ name: command.constructor.name, input: command.input });
		if (command instanceof GetObjectCommand) {
			if (!previous)
				throw Object.assign(new Error("absent"), { name: "NoSuchKey" });
			return { Body: { transformToByteArray: async () => previous } };
		}
		previous = (command.input as { Body: Uint8Array }).Body;
		return {};
	});
	return {
		workspace,
		calls,
		send,
		objects,
		get previous() {
			return previous;
		},
	};
}

test("fresh session, absent copy-in, bounded multi-part export and next-Turn restore", async () => {
	const h = harness();
	const turnId = crypto.randomUUID();
	const session = await h.workspace.start(turnId);
	await h.workspace.restore("conversation", session);
	expect(h.calls[0]).toEqual({
		name: "StartCodeInterpreterSessionCommand",
		input: {
			codeInterpreterIdentifier: "interpreter",
			clientToken: turnId,
			sessionTimeoutSeconds: 900,
		},
	});
	expect(JSON.stringify(h.calls)).toContain(
		"mkdir -p ws/artifacts ws/.mymemo/docs",
	);
	expect(JSON.stringify(h.calls)).not.toContain("writeFiles");
	await h.workspace.save("conversation", session);
	expect(h.previous?.byteLength).toBe(25 * MiB);
	for (let i = 0; i < 4; i++) expect(h.previous?.[i * 8 * MiB]).toBe(i);
	const reads = h.calls.filter(
		(c) => (c.input as { name?: string }).name === "readFiles",
	);
	expect(
		reads.map(
			(c) =>
				(c.input as { arguments: { paths: string[] } }).arguments.paths.length,
		),
	).toEqual([3, 1]);
	await h.workspace.stop(session);
	await h.workspace.restore("conversation", "next-session");
	expect(
		h.calls.some((c) => (c.input as { name?: string }).name === "writeFiles"),
	).toBe(true);
	expect(
		h.calls.some((c) =>
			(
				c.input as { arguments?: { command?: string } }
			).arguments?.command?.includes("tar xzf in.tgz -C ws"),
		),
	).toBe(true);
});

test("oversize Workspace keeps the previous object and downloads no parts", async () => {
	const h = harness(64 * MiB + 1);
	await expect(
		h.workspace.save("conversation", "session"),
	).rejects.toBeInstanceOf(WorkspaceTooLarge);
	expect(h.objects).not.toHaveBeenCalled();
	expect(h.calls).toHaveLength(1);
});

test("copy-in service errors and failed or incomplete interpreter results fail closed", async () => {
	const h = harness();
	h.objects.mockImplementationOnce(async () => {
		throw new Error("AccessDenied");
	});
	await expect(h.workspace.restore("conversation", "session")).rejects.toThrow(
		"AccessDenied",
	);
	for (const event of [
		{ result: { isError: true } },
		{ result: { structuredContent: { exitCode: 1 } } },
		{ ResourceNotFoundException: { message: "lost" } },
	]) {
		h.send.mockImplementationOnce(async () => ({
			stream: (async function* () {
				yield event;
			})(),
		}));
		await expect(h.workspace.save("conversation", "session")).rejects.toThrow();
	}
	h.send.mockImplementationOnce(async () => ({
		stream: (async function* () {})(),
	}));
	await expect(h.workspace.save("conversation", "session")).rejects.toThrow();
});

test("missing or truncated export parts never overwrite the previous Workspace", async () => {
	const h = harness(1);
	h.send.mockImplementationOnce(async () => ({
		stream: (async function* () {
			yield { result: { structuredContent: { stdout: "1", exitCode: 0 } } };
		})(),
	}));
	h.send.mockImplementationOnce(async () => ({
		stream: (async function* () {
			yield { result: { content: [] } };
		})(),
	}));
	await expect(h.workspace.save("conversation", "session")).rejects.toThrow(
		"Missing file parts",
	);
	expect(h.objects).not.toHaveBeenCalled();
});

test("readParts accepts the interpreter's UTF-8 text resources without changing bytes", async () => {
	const h = harness();
	const text = "name,value\n报告,42\n";
	h.send.mockImplementationOnce(async () => ({
		stream: (async function* () {
			yield {
				result: {
					content: [{ type: "resource", resource: { type: "text", text } }],
				},
			};
		})(),
	}));
	expect(
		await h.workspace.readParts("session", ["part-0"], Buffer.byteLength(text)),
	).toEqual(Buffer.from(text));
});

test("workspace metrics correlate both copy directions and rejected archive size", async () => {
	const log = spyOn(console, "log").mockImplementation(() => {});
	try {
		const h = harness(1);
		await h.workspace.restore("conversation", "session", "turn");
		await h.workspace.save("conversation", "session", "turn");
		await expect(
			harness(64 * MiB + 1).workspace.save("conversation", "session", "turn"),
		).rejects.toBeInstanceOf(WorkspaceTooLarge);
		const records = log.mock.calls.map(([line]) => JSON.parse(line));
		expect(records.map((r) => r.event)).toEqual([
			"workspace_restore",
			"workspace_size",
			"workspace_save",
			"workspace_size",
		]);
		for (const record of records) {
			expect(record.conversationId).toBe("conversation");
			expect(record.turnId).toBe("turn");
			if (record.copySeconds !== undefined)
				expect(record.copySeconds).toBeGreaterThanOrEqual(0);
		}
		expect(records.at(-1).tarballBytes).toBe(64 * MiB + 1);
	} finally {
		log.mockRestore();
	}
});

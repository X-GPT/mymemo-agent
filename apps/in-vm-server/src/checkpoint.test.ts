import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import {
	type CheckpointDoor,
	restoreCheckpoint,
	saveCheckpoint,
} from "./checkpoint";

/**
 * A stand-in for chat-api's `/v2/checkpoint/<conversation>` door: holds one
 * object per Conversation, records what the VM sent, and can be told to
 * fail. Served over a real socket so `Bun.file` bodies and Content-Length
 * behave as they will against the ALB.
 */
const objects = new Map<string, Uint8Array<ArrayBuffer>>();
const received: { headers: Record<string, string>; bytes: number }[] = [];
let failWith: number | null = null;
const fakeDoor = new Hono();
fakeDoor.put("/v2/checkpoint/:id", async (c) => {
	if (failWith) return c.body(null, failWith as 503);
	const body = new Uint8Array(await c.req.arrayBuffer());
	received.push({
		headers: Object.fromEntries(c.req.raw.headers),
		bytes: body.byteLength,
	});
	objects.set(c.req.param("id"), body);
	return c.body(null, 204);
});
fakeDoor.get("/v2/checkpoint/:id", (c) => {
	if (failWith) return c.body(null, failWith as 503);
	const object = objects.get(c.req.param("id"));
	if (!object) return c.body(null, 204);
	return c.body(object, 200, { "content-type": "application/gzip" });
});

let server: ReturnType<typeof Bun.serve>;
let root: string;
const logged: object[] = [];
const logger = { info: (payload: object) => logged.push(payload) };

beforeAll(async () => {
	server = Bun.serve({ port: 0, fetch: fakeDoor.fetch });
	root = await mkdtemp(path.join(tmpdir(), "checkpoint-test-"));
});

afterAll(async () => {
	server.stop(true);
	await rm(root, { recursive: true, force: true });
});

function door(id: string): CheckpointDoor {
	return {
		url: `http://127.0.0.1:${server.port}/v2/checkpoint/${id}`,
		token: "gateway-token",
		microvmId: "microvm-1",
	};
}

/** A VM's filesystem: HOME plus a Workspace outside it, as local runs have. */
function vm(name: string) {
	const homeDir = path.join(root, name, "home");
	const workspaceDir = path.join(root, name, "elsewhere", "workspace");
	mkdirSync(homeDir, { recursive: true });
	mkdirSync(workspaceDir, { recursive: true });
	return { homeDir, workspaceDir };
}

function write(base: string, relative: string, content: string) {
	const file = path.join(base, relative);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, content);
}

describe("the Checkpoint round trip (#670)", () => {
	it("saves the Agent session and Workspace through the door and restores them into a fresh VM, minus CLI scratch", async () => {
		const a = vm("a");
		write(a.homeDir, ".claude/projects/-workspace/session.jsonl", "transcript");
		write(a.homeDir, ".claude/todos/t.json", "[]");
		write(a.homeDir, ".claude/debug/noise.log", "junk");
		write(a.workspaceDir, "notes/plan.md", "# plan");
		write(a.workspaceDir, ".mymemo/docs/d1.md", "doc");

		await saveCheckpoint(a, door("conv-1"), logger);

		expect(received).toHaveLength(1);
		expect(received[0]?.headers).toMatchObject({
			authorization: "Bearer gateway-token",
			"x-mymemo-microvm-id": "microvm-1",
			"content-type": "application/gzip",
			"content-length": String(received[0]?.bytes),
		});
		expect(logged.at(-1)).toMatchObject({ bytes: received[0]?.bytes });

		const b = vm("b");
		expect(await restoreCheckpoint(b, door("conv-1"), logger)).toBe("restored");
		const read = (base: string, relative: string) =>
			readFileSync(path.join(base, relative), "utf8");
		expect(read(b.homeDir, ".claude/projects/-workspace/session.jsonl")).toBe(
			"transcript",
		);
		expect(read(b.homeDir, ".claude/todos/t.json")).toBe("[]");
		expect(read(b.workspaceDir, "notes/plan.md")).toBe("# plan");
		expect(read(b.workspaceDir, ".mymemo/docs/d1.md")).toBe("doc");
		expect(() => read(b.homeDir, ".claude/debug/noise.log")).toThrow();
	});

	it("saves a VM that never started a session (no .claude yet) and restores it cleanly", async () => {
		const a = vm("c");
		write(a.workspaceDir, "only.txt", "workspace only");
		await saveCheckpoint(a, door("conv-2"), logger);
		const b = vm("d");
		expect(await restoreCheckpoint(b, door("conv-2"), logger)).toBe("restored");
		expect(readFileSync(path.join(b.workspaceDir, "only.txt"), "utf8")).toBe(
			"workspace only",
		);
	});

	it("reports nothing to restore for a fresh Conversation", async () => {
		expect(await restoreCheckpoint(vm("e"), door("conv-new"), logger)).toBe(
			"none",
		);
	});

	it("fails loudly when the door refuses either direction", async () => {
		failWith = 503;
		try {
			await expect(
				saveCheckpoint(vm("f"), door("conv-1"), logger),
			).rejects.toThrow(/PUT answered 503/);
			await expect(
				restoreCheckpoint(vm("g"), door("conv-1"), logger),
			).rejects.toThrow(/GET answered 503/);
		} finally {
			failWith = null;
		}
	});
});

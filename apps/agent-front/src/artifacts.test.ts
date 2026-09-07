import { afterEach, expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	truncate,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import {
	GetObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { Artifacts } from "./artifacts";
import { Workspace } from "./workspace";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function harness() {
	const home = await realpath(await mkdtemp(join(tmpdir(), "artifacts-741-")));
	cleanups.push(() => rm(home, { recursive: true, force: true }));
	await mkdir(join(home, "ws/artifacts"), { recursive: true });
	const s3 = new S3Client({
		region: "us-west-2",
		credentials: { accessKeyId: "test", secretAccessKey: "test" },
	});
	const objects = new Map<string, Buffer>();
	const writes: unknown[] = [];
	spyOn(s3, "send").mockImplementation(async (command) => {
		const input = command.input as { Key: string; Body?: Uint8Array | string };
		if (command instanceof GetObjectCommand) {
			const body = objects.get(input.Key);
			if (!body)
				throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
			return {
				Body: {
					transformToString: async () => body.toString(),
					transformToByteArray: async () => body,
				},
			};
		}
		writes.push(command.input);
		if (command instanceof PutObjectCommand) {
			assert(input.Body !== undefined);
			objects.set(input.Key, Buffer.from(input.Body));
		} else objects.delete(input.Key);
		return {};
	});
	const batches: number[] = [];
	const workspace = new Workspace(
		new BedrockAgentCoreClient({ region: "us-west-2" }),
		"test",
		s3,
		"bucket",
	);
	workspace.call = async (_, name, args) => {
		if (name === "writeFiles") {
			for (const entry of args.content ?? []) {
				assert(entry.path && entry.blob);
				await writeFile(join(home, entry.path), entry.blob);
			}
			return { content: [] };
		}
		if (name === "executeCommand") {
			assert(args.command);
			const command =
				process.platform === "darwin"
					? args.command.replace("stat -c %s", "stat -f %z")
					: args.command;
			const child = Bun.spawn(["sh", "-c", command], {
				env: { ...process.env, HOME: home },
				stdout: "pipe",
				stderr: "pipe",
			});
			const stdout = await new Response(child.stdout).text();
			const stderr = await new Response(child.stderr).text();
			if (await child.exited) throw new Error(stderr);
			return { content: [], structuredContent: { stdout, exitCode: 0 } };
		}
		assert(args.paths);
		batches.push(args.paths.length);
		return {
			content: await Promise.all(
				args.paths.map(async (path) => ({
					type: "resource" as const,
					resource: {
						type: "blob" as const,
						blob: await readFile(join(home, path)),
					},
				})),
			),
		};
	};
	return {
		home,
		objects,
		writes,
		batches,
		workspace,
		artifacts: new Artifacts(s3, "bucket"),
	};
}

test("artifact mirror publishes binary chunks, stable ids/timestamps, sorted listings and signed attachment downloads", async () => {
	const h = await harness();
	expect(await h.artifacts.list("c")).toEqual([]);
	const bytes = Buffer.alloc(25 * 1024 * 1024, 173);
	await writeFile(join(h.home, "ws/artifacts/z.png"), bytes);
	await writeFile(join(h.home, "ws/artifacts/empty.txt"), "");
	await writeFile(join(h.home, "ws/artifacts/报告 'x'.csv"), "x\n42");
	const first = await h.artifacts.sync("c", "s", h.workspace);
	expect(first.artifacts).toHaveLength(3);
	expect(first.removed).toEqual([]);
	expect(h.batches).toContain(3);
	expect(Math.max(...h.batches)).toBe(3);
	expect(h.objects.get("_artifacts/c/z.png")).toEqual(bytes);
	const listed = await h.artifacts.list("c");
	expect(listed.map((a) => a.path)).toEqual([
		"empty.txt",
		"z.png",
		"报告 'x'.csv",
	]);
	expect(listed.some((a) => "mtime" in a)).toBe(false);
	const [empty, png, csv] = listed;
	assert(empty && png && csv);
	expect(png.artifactId).toBe(
		createHash("sha256").update("z.png").digest("base64url"),
	);
	expect(png.contentType).toBe("image/png");
	const signed = await h.artifacts.downloadUrl("c", csv.artifactId);
	assert(signed);
	const url = new URL(signed);
	expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
	expect(url.searchParams.get("response-content-disposition")).toStartWith(
		"attachment; filename*=UTF-8''",
	);
	expect(url.pathname).toContain("_artifacts/c/");
	expect(await h.artifacts.downloadUrl("c", "unknown")).toBeUndefined();
	const writes = h.writes.length;
	expect(await h.artifacts.sync("c", "s", h.workspace)).toEqual({
		artifacts: [],
		removed: [],
	});
	expect(h.writes).toHaveLength(writes);
	await writeFile(join(h.home, "ws/artifacts/z.png"), "new");
	await rm(join(h.home, "ws/artifacts/empty.txt"));
	const next = await h.artifacts.sync("c", "s", h.workspace);
	expect(next.artifacts).toHaveLength(1);
	expect(next.artifacts[0]).toMatchObject({
		artifactId: png.artifactId,
		createdAt: png.createdAt,
		sizeBytes: 3,
	});
	assert(next.artifacts[0]);
	expect(next.artifacts[0].updatedAt >= png.updatedAt).toBe(true);
	expect(next.removed).toEqual([empty.artifactId]);
	expect(h.objects.has("_artifacts/c/empty.txt")).toBe(false);
	expect(await h.artifacts.downloadUrl("c", empty.artifactId)).toBeUndefined();
});

test("discovery excludes symlinks, reserved manifest and oversized files; unnormalised paths fail closed", async () => {
	const h = await harness();
	await writeFile(join(h.home, "outside"), "private");
	await symlink(join(h.home, "outside"), join(h.home, "ws/artifacts/link"));
	await symlink(h.home, join(h.home, "ws/artifacts/dir-link"));
	await writeFile(join(h.home, "ws/artifacts/.manifest.json"), "poison");
	await writeFile(join(h.home, "ws/artifacts/huge"), "");
	await truncate(join(h.home, "ws/artifacts/huge"), 100 * 1024 * 1024 + 1);
	expect(await h.artifacts.sync("c", "s", h.workspace)).toEqual({
		artifacts: [],
		removed: [],
	});
	for (const path of [
		"../secret",
		"/secret",
		"a/../b",
		"a//b",
		"a\\b",
		".manifest.json",
		"bad\nname",
	]) {
		await expect(
			h.artifacts.sync("c", "s", {
				readParts: Workspace.prototype.readParts,
				call: async () => ({
					content: [],
					structuredContent: {
						stdout: JSON.stringify([{ path, sizeBytes: 0, mtime: "1" }]),
					},
				}),
			}),
		).rejects.toThrow();
	}
	expect(h.writes).toHaveLength(0);
});

test("incomplete binary reads never publish a manifest or file", async () => {
	const h = await harness();
	await writeFile(join(h.home, "ws/artifacts/a.bin"), "abc");
	const call = h.workspace.call;
	for (const content of [
		[],
		[
			{
				type: "resource" as const,
				resource: { type: "blob" as const, blob: new Uint8Array(1) },
			},
		],
	]) {
		await expect(
			h.artifacts.sync("c", "s", {
				readParts: Workspace.prototype.readParts,
				call: (session, name, args) =>
					name === "readFiles"
						? Promise.resolve({ content })
						: call(session, name, args),
			}),
		).rejects.toThrow();
	}
	expect(h.writes).toHaveLength(0);
});

test("untouched artifacts keep their nanosecond mtime and emit no changes after Workspace save/restore", async () => {
	const h = await harness();
	const file = join(h.home, "ws/artifacts/chart.png");
	await writeFile(file, "png");
	await utimes(file, 1700000000.123, 1700000000.123);
	const first = await h.artifacts.sync("c", "s", h.workspace);
	await h.workspace.save("c", "s");
	await rm(join(h.home, "ws"), { recursive: true });
	await h.workspace.restore("c", "fresh-session");
	const writes = h.writes.length;
	expect(await h.artifacts.sync("c", "fresh-session", h.workspace)).toEqual({
		artifacts: [],
		removed: [],
	});
	expect(await h.artifacts.list("c")).toEqual(first.artifacts);
	expect(h.writes).toHaveLength(writes);
});

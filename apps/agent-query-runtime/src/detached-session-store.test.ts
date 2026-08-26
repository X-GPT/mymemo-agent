import { expect, it } from "bun:test";
import {
	GetObjectCommand,
	NoSuchKey,
	PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
	createS3DetachedSessionStore,
	MAX_DETACHED_SESSION_BYTES,
} from "./detached-session-store";

it("treats a missing Conversation session object as a new Agent session", async () => {
	const store = createS3DetachedSessionStore({
		bucket: "private-artifacts",
		client: {
			send: async (command: GetObjectCommand) => {
				expect(command).toBeInstanceOf(GetObjectCommand);
				expect(command.input).toEqual({
					Bucket: "private-artifacts",
					Key: "agent-sessions/conversation-1",
				});
				throw new NoSuchKey({ $metadata: {}, message: "missing" });
			},
		} as never,
	});

	expect(await store.load("conversation-1")).toBeNull();
});

it("round-trips, replaces, and isolates complete Conversation session objects", async () => {
	const objects = new Map<string, Uint8Array>();
	const store = createS3DetachedSessionStore({
		bucket: "private-artifacts",
		client: {
			send: async (command: GetObjectCommand | PutObjectCommand) => {
				if (command instanceof PutObjectCommand) {
					objects.set(
						command.input.Key as string,
						command.input.Body as Uint8Array,
					);
					return {};
				}
				if (command instanceof GetObjectCommand) {
					const body = objects.get(command.input.Key as string);
					if (!body) {
						throw new NoSuchKey({ $metadata: {}, message: "missing" });
					}
					return {
						Body: {
							transformToString: async () => new TextDecoder().decode(body),
						},
					};
				}
				throw new Error("unexpected command");
			},
		} as never,
	});
	const first = { version: 1, opaque: [{ nested: "first" }] };
	const replacement = { version: 1, opaque: [{ nested: "replacement" }] };
	const other = { version: 1, opaque: [{ nested: "other" }] };

	await store.save("conversation-1", first);
	expect(await store.load("conversation-1")).toEqual(first);
	await store.save("conversation-1", replacement);
	await store.save("conversation-2", other);

	expect(await store.load("conversation-1")).toEqual(replacement);
	expect(await store.load("conversation-2")).toEqual(other);
});

it("rejects detached state above 100 MiB before upload", async () => {
	let uploads = 0;
	const store = createS3DetachedSessionStore({
		bucket: "private-artifacts",
		client: {
			send: async () => {
				uploads++;
			},
		} as never,
	});

	await expect(
		store.save("conversation-1", {
			opaque: "x".repeat(MAX_DETACHED_SESSION_BYTES),
		}),
	).rejects.toThrow("100 MiB");
	expect(uploads).toBe(0);
});

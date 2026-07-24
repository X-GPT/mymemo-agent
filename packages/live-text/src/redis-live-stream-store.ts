import { randomUUID } from "node:crypto";
import type {
	ResumableStreamAcquireOptions,
	ResumableStreamEntry,
	ResumableStreamRole,
	ResumableStreamStatus,
	ResumableStreamStore,
} from "assistant-stream/resumable";
import { createClient } from "redis";
import {
	decodeAgUiLiveStreamEvent,
	LIVE_STREAM_MAX_BYTES,
	LIVE_STREAM_MAX_EVENT_BYTES,
	LIVE_STREAM_MAX_EVENTS,
	LiveStreamStoreError,
} from "./live-stream-events";

export const LIVE_STREAM_RETENTION_MS = 30 * 60 * 1_000;

const MAX_RUN_ID_LENGTH = 128;
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_DEPLOYMENT_LENGTH = 64;
const DEPLOYMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const DEFAULT_REDIS_OPERATION_TIMEOUT_MS = 250;
const DEFAULT_REDIS_POLL_INTERVAL_MS = 100;
const REDIS_BLOB_STRING = 36;
const REDIS_STREAM_ID_PATTERN = /^(0|[1-9]\d*)-(0|[1-9]\d*)$/;
const REDIS_STREAM_ID_PART_MAX = (1n << 64n) - 1n;

const ACQUIRE_SCRIPT = `
if redis.call("EXISTS", KEYS[1]) == 1 then
	return 0
end
redis.call("DEL", KEYS[2])
local result = redis.call("SET", KEYS[1], ARGV[1], "NX", "PX", ARGV[2])
if result then
	return 1
end
return 0
`;

const APPEND_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then
	return {"missing"}
end
local meta = cjson.decode(raw)
if meta.status ~= "streaming" then
	return {"finalized"}
end
if meta.producerToken ~= ARGV[6] then
	return {"not_producer"}
end
local eventBytes = string.len(ARGV[1])
if eventBytes > tonumber(ARGV[2]) then
	return {"event_too_large"}
end
local appendId = ARGV[5]
local digest = redis.sha1hex(ARGV[1])
if appendId ~= "" and meta.lastAppendId == appendId then
	if meta.lastAppendDigest ~= digest then
		return {"append_retry_conflict"}
	end
	redis.call("SET", KEYS[1], cjson.encode(meta), "PX", meta.ttlMs)
	if redis.call("EXISTS", KEYS[2]) == 1 then
		redis.call("PEXPIRE", KEYS[2], meta.ttlMs)
	end
	return {"ok", meta.lastCursor, "retry"}
end
local nextBytes = (meta.bytes or 0) + eventBytes
if nextBytes > tonumber(ARGV[3]) then
	return {"stream_bytes_exceeded"}
end
local nextEntries = (meta.entries or 0) + 1
if nextEntries > tonumber(ARGV[4]) then
	return {"stream_events_exceeded"}
end
local cursor = redis.call("XADD", KEYS[2], "*", "event", ARGV[1])
meta.bytes = nextBytes
meta.entries = nextEntries
if appendId ~= "" then
	meta.lastAppendId = appendId
	meta.lastAppendDigest = digest
	meta.lastCursor = cursor
else
	meta.lastAppendId = nil
	meta.lastAppendDigest = nil
	meta.lastCursor = nil
end
redis.call("SET", KEYS[1], cjson.encode(meta), "PX", meta.ttlMs)
redis.call("PEXPIRE", KEYS[2], meta.ttlMs)
return {"ok", cursor, "append"}
`;

const FINALIZE_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then
	return "missing"
end
local meta = cjson.decode(raw)
if meta.producerToken ~= ARGV[3] then
	return "not_producer"
end
if meta.status ~= "streaming" then
	if meta.status == ARGV[1] and (ARGV[1] ~= "error" or (meta.error or "") == ARGV[2]) then
		return "retry"
	end
	return "conflict"
end
meta.status = ARGV[1]
if ARGV[1] == "error" then
	meta.error = ARGV[2]
else
	meta.error = nil
end
redis.call("SET", KEYS[1], cjson.encode(meta), "PX", meta.ttlMs)
if redis.call("EXISTS", KEYS[2]) == 1 then
	redis.call("PEXPIRE", KEYS[2], meta.ttlMs)
end
return "finalized"
`;

const REFRESH_SCRIPT = `
local raw = redis.call("GET", KEYS[1])
if not raw then
	return "missing"
end
local meta = cjson.decode(raw)
if meta.producerToken ~= ARGV[1] then
	return "not_producer"
end
if meta.status ~= "streaming" then
	return "finalized"
end
redis.call("SET", KEYS[1], raw, "PX", meta.ttlMs)
if redis.call("EXISTS", KEYS[2]) == 1 then
	redis.call("PEXPIRE", KEYS[2], meta.ttlMs)
end
return "refreshed"
`;

type RedisClient = ReturnType<typeof createClient>;
const EVENT_ENCODER = new TextEncoder();

export interface RedisLiveStreamStoreOptions {
	/** Authenticated rediss:// in production; loopback redis:// is test-only. */
	url: string;
	deployment: string;
	/** Lower hard limits for disposable real-Redis contract tests only. */
	testLimits?: {
		retentionMs?: number;
		maxEventBytes?: number;
		maxStreamBytes?: number;
		maxEvents?: number;
	};
}

export interface LiveStreamStore extends ResumableStreamStore {
	/** Deduplicate an immediate retry in the sequential producer append path. */
	appendWithRetryId(
		streamId: string,
		retryId: string,
		chunk: Uint8Array,
	): Promise<{ cursor: string; appended: boolean }>;
	refresh(streamId: string): Promise<boolean>;
	close(): Promise<void>;
}

/** Consumer-only boundary used by chat-api. Producer ownership and mutation
 * methods stay unavailable at the HTTP edge. */
export type LiveStreamReader = Pick<LiveStreamStore, "read" | "status">;

class RedisLiveStreamStore implements LiveStreamStore {
	readonly #client: RedisClient;
	readonly #keyPrefix: string;
	readonly #retentionMs: number;
	readonly #maxEventBytes: number;
	readonly #maxStreamBytes: number;
	readonly #maxEvents: number;
	readonly #producerTokens = new Map<string, string>();
	#connecting: Promise<void> | undefined;
	#closed = false;

	constructor(options: RedisLiveStreamStoreOptions) {
		if (
			options.deployment.length < 1 ||
			options.deployment.length > MAX_DEPLOYMENT_LENGTH ||
			!DEPLOYMENT_PATTERN.test(options.deployment)
		) {
			throw new Error("deployment must be a path-safe identifier");
		}
		this.#retentionMs = Math.min(
			positiveInteger(
				options.testLimits?.retentionMs ?? LIVE_STREAM_RETENTION_MS,
				"retentionMs",
			),
			LIVE_STREAM_RETENTION_MS,
		);
		this.#maxEventBytes = Math.min(
			positiveInteger(
				options.testLimits?.maxEventBytes ?? LIVE_STREAM_MAX_EVENT_BYTES,
				"maxEventBytes",
			),
			LIVE_STREAM_MAX_EVENT_BYTES,
		);
		this.#maxStreamBytes = Math.min(
			positiveInteger(
				options.testLimits?.maxStreamBytes ?? LIVE_STREAM_MAX_BYTES,
				"maxStreamBytes",
			),
			LIVE_STREAM_MAX_BYTES,
		);
		this.#maxEvents = Math.min(
			positiveInteger(
				options.testLimits?.maxEvents ?? LIVE_STREAM_MAX_EVENTS,
				"maxEvents",
			),
			LIVE_STREAM_MAX_EVENTS,
		);
		this.#keyPrefix = `${options.deployment}:mymemo:agui`;
		this.#client = createClient({
			url: options.url,
			socket: {
				connectTimeout: DEFAULT_REDIS_OPERATION_TIMEOUT_MS,
				reconnectStrategy: false,
			},
		});
		this.#client.on("error", () => {});
	}

	async acquire(
		streamId: string,
		options: ResumableStreamAcquireOptions = {},
	): Promise<ResumableStreamRole> {
		this.#assertOpen();
		validateRunId(streamId);
		if (
			options.ttlMs !== undefined &&
			positiveInteger(options.ttlMs, "ttlMs") !== this.#retentionMs
		) {
			throw new Error("ttlMs is fixed by the Live Stream retention policy");
		}
		const ttlMs = this.#retentionMs;
		const producerToken = randomUUID();
		const metadata = JSON.stringify({
			status: "streaming",
			ttlMs,
			bytes: 0,
			entries: 0,
			producerToken,
		});
		const result = await this.#bounded(async () => {
			await this.#connect();
			return this.#client.eval(ACQUIRE_SCRIPT, {
				keys: [this.#metaKey(streamId), this.#streamKey(streamId)],
				arguments: [metadata, String(ttlMs)],
			});
		});
		if (result === 1) {
			this.#producerTokens.set(streamId, producerToken);
			return "producer";
		}
		return "consumer";
	}

	async append(streamId: string, chunk: Uint8Array): Promise<void> {
		await this.#appendAtomically(streamId, "", chunk);
	}

	async appendWithRetryId(
		streamId: string,
		retryId: string,
		chunk: Uint8Array,
	): Promise<{ cursor: string; appended: boolean }> {
		validateRetryId(retryId);
		return this.#appendAtomically(streamId, retryId, chunk);
	}

	async #appendAtomically(
		streamId: string,
		appendId: string,
		chunk: Uint8Array,
	): Promise<{ cursor: string; appended: boolean }> {
		this.#assertOpen();
		validateRunId(streamId);
		validateEncodedAgUiEvent(chunk);
		const producerToken = this.#producerToken(streamId);
		const result = parseArrayReply(
			await this.#command([
				"EVAL",
				APPEND_SCRIPT,
				"2",
				this.#metaKey(streamId),
				this.#streamKey(streamId),
				toBuffer(chunk),
				String(this.#maxEventBytes),
				String(this.#maxStreamBytes),
				String(this.#maxEvents),
				appendId,
				producerToken,
			]),
		);
		if (result[0] !== "ok") throw storeError(result[0]);
		const cursor = result[1];
		if (!cursor) throw new LiveStreamStoreError("missing");
		return { cursor, appended: result[2] !== "retry" };
	}

	async finalize(
		streamId: string,
		status: "done" | "error",
		error?: string,
	): Promise<void> {
		this.#assertOpen();
		validateRunId(streamId);
		const producerToken = this.#producerToken(streamId);
		const result = replyString(
			await this.#command([
				"EVAL",
				FINALIZE_SCRIPT,
				"2",
				this.#metaKey(streamId),
				this.#streamKey(streamId),
				status,
				error ?? "Stream errored",
				producerToken,
			]),
		);
		if (result === "finalized" || result === "retry") return;
		if (result === "not_producer") {
			throw new LiveStreamStoreError("not_producer");
		}
		if (result === "conflict") {
			throw new LiveStreamStoreError("finalize_conflict");
		}
		throw new LiveStreamStoreError("missing");
	}

	async refresh(streamId: string): Promise<boolean> {
		this.#assertOpen();
		validateRunId(streamId);
		const producerToken = this.#producerToken(streamId);
		const result = replyString(
			await this.#command([
				"EVAL",
				REFRESH_SCRIPT,
				"2",
				this.#metaKey(streamId),
				this.#streamKey(streamId),
				producerToken,
			]),
		);
		if (result === "refreshed") return true;
		if (result === "finalized") return false;
		if (result === "not_producer") {
			throw new LiveStreamStoreError("not_producer");
		}
		throw new LiveStreamStoreError("missing");
	}

	async *read(
		streamId: string,
		cursor: string,
		signal: AbortSignal,
	): AsyncIterable<ResumableStreamEntry> {
		this.#assertOpen();
		validateRunId(streamId);
		const normalizedCursor = parseLiveStreamCursor(cursor);
		const initialMetadata = await this.#readMetadata(streamId);
		if (!initialMetadata) {
			throw new LiveStreamStoreError("missing");
		}
		if (normalizedCursor !== "") {
			const rawEntries = await this.#command(
				[
					"XRANGE",
					this.#streamKey(streamId),
					normalizedCursor,
					normalizedCursor,
					"COUNT",
					"1",
				],
				true,
			);
			const exactEntry = Array.isArray(rawEntries)
				? parseStreamEntry(rawEntries[0])
				: undefined;
			if (exactEntry?.cursor !== normalizedCursor) {
				const streamExists = replyInteger(
					await this.#command(["EXISTS", this.#streamKey(streamId)]),
				);
				if (streamExists === 0 && initialMetadata.status !== "streaming") {
					throw new LiveStreamStoreError("missing");
				}
				throw new LiveStreamStoreError("invalid_cursor");
			}
		}
		let lastCursor = normalizedCursor === "" ? "0-0" : normalizedCursor;
		while (!signal.aborted) {
			const metadata = await this.#readMetadata(streamId);
			if (!metadata) return;
			const entries = parseXReadReply(
				await this.#command(
					[
						"XREAD",
						"COUNT",
						"100",
						"STREAMS",
						this.#streamKey(streamId),
						lastCursor,
					],
					true,
				),
			);
			for (const entry of entries) {
				if (signal.aborted) return;
				lastCursor = entry.cursor;
				yield entry;
			}
			if (entries.length > 0) continue;

			if (metadata.status === "done") return;
			if (metadata.status === "error") {
				throw new Error(metadata.error ?? "Stream errored");
			}
			await abortableDelay(DEFAULT_REDIS_POLL_INTERVAL_MS, signal);
		}
	}

	async status(streamId: string): Promise<ResumableStreamStatus> {
		this.#assertOpen();
		validateRunId(streamId);
		const metadata = await this.#readMetadata(streamId);
		if (!metadata) return "missing";
		if (
			metadata.status === "streaming" ||
			metadata.status === "done" ||
			metadata.status === "error"
		) {
			return metadata.status;
		}
		return "missing";
	}

	async delete(streamId: string): Promise<void> {
		this.#assertOpen();
		validateRunId(streamId);
		await this.#command([
			"DEL",
			this.#metaKey(streamId),
			this.#streamKey(streamId),
		]);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#producerTokens.clear();
		try {
			this.#client.destroy();
		} catch {
			// Closing is idempotent and best-effort.
		}
	}

	async #connect(): Promise<void> {
		if (this.#client.isReady) return;
		if (!this.#connecting) {
			this.#connecting = this.#client
				.connect()
				.then(() => {})
				.finally(() => {
					this.#connecting = undefined;
				});
		}
		await this.#connecting;
	}

	async #bounded<T>(operation: () => Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error("Live Stream Redis operation timed out")),
				DEFAULT_REDIS_OPERATION_TIMEOUT_MS,
			);
		});
		try {
			return await Promise.race([operation(), timeout]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	async #command(
		args: Array<string | Buffer>,
		binary = false,
	): Promise<unknown> {
		return this.#bounded(async () => {
			await this.#connect();
			return this.#client.sendCommand(args, {
				...(binary ? { typeMapping: { [REDIS_BLOB_STRING]: Buffer } } : {}),
			});
		});
	}

	async #readMetadata(streamId: string): Promise<StreamMetadata | undefined> {
		const raw = replyString(
			await this.#command(["GET", this.#metaKey(streamId)]),
		);
		if (raw === undefined) return undefined;
		try {
			const parsed = JSON.parse(raw) as StreamMetadata;
			return parsed && typeof parsed === "object" ? parsed : undefined;
		} catch {
			return undefined;
		}
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("Live Stream store is closed");
	}

	#producerToken(streamId: string): string {
		const producerToken = this.#producerTokens.get(streamId);
		if (!producerToken) throw new LiveStreamStoreError("not_producer");
		return producerToken;
	}

	#metaKey(streamId: string): string {
		return `${this.#keyPrefix}:{${streamId}}:meta`;
	}

	#streamKey(streamId: string): string {
		return `${this.#keyPrefix}:{${streamId}}:stream`;
	}
}

export function createRedisLiveStreamStore(
	options: RedisLiveStreamStoreOptions,
): LiveStreamStore {
	return new RedisLiveStreamStore(options);
}

function validateRunId(streamId: string): void {
	if (
		streamId.length < 1 ||
		streamId.length > MAX_RUN_ID_LENGTH ||
		!RUN_ID_PATTERN.test(streamId)
	) {
		throw new Error("streamId must be a path-safe Run identifier");
	}
}

function validateRetryId(retryId: string): void {
	if (
		retryId.length < 1 ||
		retryId.length > MAX_RUN_ID_LENGTH ||
		!RUN_ID_PATTERN.test(retryId)
	) {
		throw new Error("retryId must be a path-safe identifier");
	}
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error(`${name} must be a positive integer`);
	}
	return value;
}

function validateEncodedAgUiEvent(chunk: Uint8Array): void {
	decodeAgUiLiveStreamEvent(chunk);
}

interface StreamMetadata {
	status?: string;
	error?: string;
}

export function parseLiveStreamCursor(cursor: string | undefined): string {
	if (cursor === undefined || cursor === "" || cursor === "0") return "";
	const match = REDIS_STREAM_ID_PATTERN.exec(cursor);
	if (
		match?.[1] !== undefined &&
		match[2] !== undefined &&
		BigInt(match[1]) <= REDIS_STREAM_ID_PART_MAX &&
		BigInt(match[2]) <= REDIS_STREAM_ID_PART_MAX
	) {
		return cursor;
	}
	throw new LiveStreamStoreError("invalid_cursor");
}

function toBuffer(bytes: Uint8Array): Buffer {
	if (Buffer.isBuffer(bytes)) return bytes;
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function replyString(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (Buffer.isBuffer(value)) return value.toString("utf8");
	return undefined;
}

function replyInteger(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isSafeInteger(value)) return value;
	if (typeof value === "bigint") {
		const parsed = Number(value);
		return Number.isSafeInteger(parsed) ? parsed : undefined;
	}
	const raw = replyString(value);
	if (raw === undefined || !/^-?\d+$/.test(raw)) return undefined;
	const parsed = Number(raw);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseArrayReply(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		const parsed = replyString(item);
		return parsed === undefined ? [] : [parsed];
	});
}

function parseXReadReply(value: unknown): ResumableStreamEntry[] {
	if (!Array.isArray(value)) return [];
	const entries: ResumableStreamEntry[] = [];
	for (const rawStream of value) {
		if (!Array.isArray(rawStream) || !Array.isArray(rawStream[1])) continue;
		for (const rawEntry of rawStream[1]) {
			const entry = parseStreamEntry(rawEntry);
			if (entry) entries.push(entry);
		}
	}
	return entries;
}

function parseStreamEntry(rawEntry: unknown): ResumableStreamEntry | undefined {
	if (!Array.isArray(rawEntry) || rawEntry.length < 2) return undefined;
	const cursor = replyString(rawEntry[0]);
	const fields = rawEntry[1];
	if (!cursor || !Array.isArray(fields)) return undefined;
	for (let index = 0; index + 1 < fields.length; index += 2) {
		if (replyString(fields[index]) !== "event") continue;
		const event = fields[index + 1];
		if (typeof event === "string") {
			return { cursor, chunk: EVENT_ENCODER.encode(event) };
		}
		if (Buffer.isBuffer(event)) {
			return {
				cursor,
				chunk: new Uint8Array(event.buffer, event.byteOffset, event.byteLength),
			};
		}
	}
	return undefined;
}

function storeError(code: string | undefined): LiveStreamStoreError {
	if (
		code === "missing" ||
		code === "finalized" ||
		code === "not_producer" ||
		code === "append_retry_conflict" ||
		code === "event_too_large" ||
		code === "stream_bytes_exceeded" ||
		code === "stream_events_exceeded"
	) {
		return new LiveStreamStoreError(code);
	}
	return new LiveStreamStoreError("missing");
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done(): void {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}

export * from "./live-stream-telemetry";
export * from "./redis-live-stream-store";

/** Validate the required Redis Live Stream secret without connecting at boot. */
export function resolveLiveStreamRedisUrl(
	raw: string | undefined,
	options: { allowInsecureLoopback?: boolean } = {},
): string {
	if (!raw) throw new Error("REDIS_URL is required");
	try {
		const url = new URL(raw);
		if (
			options.allowInsecureLoopback === true &&
			url.protocol === "redis:" &&
			(url.hostname === "127.0.0.1" ||
				url.hostname === "localhost" ||
				url.hostname === "[::1]")
		) {
			return raw;
		}
		if (url.protocol !== "rediss:" || !url.hostname || !url.password) {
			throw new Error();
		}
		return raw;
	} catch {
		throw new Error(
			"REDIS_URL must be an authenticated rediss:// URL (plaintext loopback is test-only)",
		);
	}
}

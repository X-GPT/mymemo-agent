import {
	createRedisLiveTextTransport,
	type LiveTextTransport,
	type RedisLiveTextSignal,
} from "@mymemo/live-text";

interface LiveTextLogger {
	info(event: Record<string, unknown>): void;
	warn(event: Record<string, unknown>): void;
}

/** Select the lazy production publisher only for validated Redis config. */
export function createWorkerLiveTextTransport(
	redisUrl: string | undefined,
	logger: LiveTextLogger,
): LiveTextTransport | undefined {
	if (redisUrl === undefined) {
		try {
			logger.info({
				message: "Live preview Redis transport state changed",
				signal: "disabled",
			});
		} catch {
			// Telemetry is optional and must never affect worker boot.
		}
		return undefined;
	}
	return createRedisLiveTextTransport({
		url: redisUrl,
		onSignal: (signal: RedisLiveTextSignal) => {
			const event = {
				message: "Live preview Redis transport state changed",
				signal,
			};
			if (signal === "recovered") logger.info(event);
			else logger.warn(event);
		},
	});
}

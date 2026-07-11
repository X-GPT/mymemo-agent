export type LiveTextService = "agent-worker" | "chat-api";

export type LiveTextSignal =
	| "attempted"
	| "degraded"
	| "delivered"
	| "disabled"
	| "dropped"
	| "gap_detected"
	| "impossible_ordering"
	| "malformed"
	| "mismatch"
	| "queue_overflow"
	| "recovered"
	| "slow_client";

export type LiveTextReason =
	| "adapter_message"
	| "configuration"
	| "connection_buffer"
	| "delta_gap"
	| "duplicate_delta"
	| "late_delta"
	| "message_projection"
	| "message_publication"
	| "partial_complete"
	| "provider_envelope"
	| "publisher"
	| "reconciliation_state"
	| "redis_connection"
	| "run_aborted"
	| "run_ended"
	| "subscription"
	| "subscription_timeout"
	| "terminal_preview"
	| "transport_channel"
	| "worker_queue";

export type LiveTextOutcome = "attempted" | "delivered" | "dropped";

export interface LiveTextTelemetryEvent extends Record<string, unknown> {
	message: "Live preview signal";
	service: LiveTextService;
	signal: LiveTextSignal;
	reason: LiveTextReason;
	outcome?: LiveTextOutcome;
	count: 1;
}

interface LiveTextTelemetryLogger {
	info(event: LiveTextTelemetryEvent): void;
	warn(event: LiveTextTelemetryEvent): void;
}

export interface LiveTextTelemetry {
	close(): void;
	disabled(reason: LiveTextReason): void;
	degraded(reason: LiveTextReason): void;
	recovered(reason: LiveTextReason): void;
	recordRecovery(reason: LiveTextReason): void;
	record(
		signal: Exclude<LiveTextSignal, "disabled" | "degraded" | "recovered">,
		reason: LiveTextReason,
		outcome?: LiveTextOutcome,
	): void;
}

/**
 * Builds the complete, bounded structured event before it reaches the logger.
 * Callers cannot attach text, credentials, or per-request identifiers, and a
 * telemetry failure can never affect the optional Live lane.
 */
export function createLiveTextTelemetry(
	service: LiveTextService,
	logger: LiveTextTelemetryLogger,
	options: { degradedHeartbeatMs?: number } = {},
): LiveTextTelemetry {
	const degradedHeartbeatMs = options.degradedHeartbeatMs ?? 300_000;
	if (!Number.isSafeInteger(degradedHeartbeatMs) || degradedHeartbeatMs < 1) {
		throw new Error("degradedHeartbeatMs must be a positive integer");
	}
	const disabledReasons = new Set<LiveTextReason>();
	const degradedReasons = new Set<LiveTextReason>();
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	let closed = false;
	const emit = (
		signal: LiveTextSignal,
		reason: LiveTextReason,
		outcome?: LiveTextOutcome,
	) => {
		const event: LiveTextTelemetryEvent = {
			message: "Live preview signal",
			service,
			signal,
			reason,
			...(outcome ? { outcome } : {}),
			count: 1,
		};
		try {
			if (
				signal === "disabled" ||
				signal === "recovered" ||
				signal === "attempted" ||
				signal === "delivered"
			) {
				logger.info(event);
			} else {
				logger.warn(event);
			}
		} catch {
			// Observability is optional and must not change boot, health, or delivery.
		}
	};
	const stopHeartbeat = () => {
		if (heartbeatTimer === undefined) return;
		clearInterval(heartbeatTimer);
		heartbeatTimer = undefined;
	};
	const startHeartbeat = () => {
		if (heartbeatTimer !== undefined) return;
		heartbeatTimer = setInterval(() => {
			for (const reason of degradedReasons) emit("degraded", reason);
		}, degradedHeartbeatMs);
		heartbeatTimer.unref?.();
	};

	return {
		close() {
			closed = true;
			stopHeartbeat();
		},
		disabled(reason) {
			if (closed) return;
			if (disabledReasons.has(reason)) return;
			disabledReasons.add(reason);
			emit("disabled", reason);
		},
		degraded(reason) {
			if (closed) return;
			if (degradedReasons.has(reason)) return;
			degradedReasons.add(reason);
			emit("degraded", reason);
			startHeartbeat();
		},
		recovered(reason) {
			if (closed) return;
			if (!degradedReasons.delete(reason)) return;
			emit("recovered", reason);
			if (degradedReasons.size === 0) stopHeartbeat();
		},
		recordRecovery(reason) {
			if (closed) return;
			emit("recovered", reason);
		},
		record(signal, reason, outcome) {
			if (closed) return;
			emit(signal, reason, outcome);
		},
	};
}

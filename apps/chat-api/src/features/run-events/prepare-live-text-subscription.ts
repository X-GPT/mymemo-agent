import type {
	LiveTextSubscriber,
	LiveTextSubscription,
} from "@mymemo/live-text";
import { LiveTextDisabledError } from "@mymemo/live-text";

export const LIVE_TEXT_SUBSCRIBE_TIMEOUT_MS = 100;
const TIMED_OUT = Symbol("live text subscription timed out");

export type LiveTextSetupSignal = "degraded" | "disabled";

function emitSignal(
	onSignal: ((signal: LiveTextSetupSignal) => void) | undefined,
	signal: LiveTextSetupSignal,
): void {
	try {
		onSignal?.(signal);
	} catch {
		// Telemetry is optional and cannot fail request admission.
	}
}

export async function prepareLiveTextSubscription(
	subscriber: LiveTextSubscriber,
	runId: string,
	options: {
		timeoutMs?: number;
		onSignal?: (signal: LiveTextSetupSignal) => void;
	} = {},
): Promise<LiveTextSubscription | null> {
	const timeoutMs = options.timeoutMs ?? LIVE_TEXT_SUBSCRIBE_TIMEOUT_MS;
	let prepared: Promise<LiveTextSubscription>;
	try {
		prepared = subscriber.subscribe(runId);
	} catch (error) {
		emitSignal(
			options.onSignal,
			error instanceof LiveTextDisabledError ? "disabled" : "degraded",
		);
		return null;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
		timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
	});
	try {
		const result = await Promise.race([prepared, timeout]);
		if (result !== TIMED_OUT) return result;
		emitSignal(options.onSignal, "degraded");
		void prepared.then((subscription) => subscription.close()).catch(() => {});
		return null;
	} catch (error) {
		emitSignal(
			options.onSignal,
			error instanceof LiveTextDisabledError ? "disabled" : "degraded",
		);
		return null;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

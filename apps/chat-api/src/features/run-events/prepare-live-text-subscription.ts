import type {
	LiveTextSubscriber,
	LiveTextSubscription,
} from "@mymemo/live-text";

export const LIVE_TEXT_SUBSCRIBE_TIMEOUT_MS = 100;
const TIMED_OUT = Symbol("live text subscription timed out");

export async function prepareLiveTextSubscription(
	subscriber: LiveTextSubscriber,
	runId: string,
	timeoutMs = LIVE_TEXT_SUBSCRIBE_TIMEOUT_MS,
): Promise<LiveTextSubscription | null> {
	let prepared: Promise<LiveTextSubscription>;
	try {
		prepared = subscriber.subscribe(runId);
	} catch {
		return null;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
		timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
	});
	try {
		const result = await Promise.race([prepared, timeout]);
		if (result !== TIMED_OUT) return result;
		void prepared.then((subscription) => subscription.close()).catch(() => {});
		return null;
	} catch {
		return null;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

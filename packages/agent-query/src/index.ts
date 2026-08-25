/** The versioned Chat API to AgentCore Runtime request boundary. */
export type AgentQueryRequest = {
	version: 1;
	conversationId: string;
	conversationEpoch: number;
	prompt: string;
	model: string;
	agentSessionId?: string;
};

/** Stop response work when its last database-confirmed deadline lapses. */
export function watchResponseAuthority(input: {
	initialDeadline: Date;
	intervalMs: number;
	verify(): Promise<Date | null>;
}) {
	const controller = new AbortController();
	let stopped = false;
	let verifying = false;
	let deadlineTimer: ReturnType<typeof setTimeout>;
	const revoke = () => controller.abort(new Error("Response authority lost"));
	const scheduleDeadline = (deadline: Date) => {
		clearTimeout(deadlineTimer);
		deadlineTimer = setTimeout(
			revoke,
			Math.max(0, deadline.getTime() - Date.now()),
		);
	};
	scheduleDeadline(input.initialDeadline);
	const interval = setInterval(async () => {
		if (stopped || verifying) return;
		verifying = true;
		try {
			const deadline = await input.verify();
			if (stopped) return;
			if (deadline) scheduleDeadline(deadline);
			else revoke();
		} catch {
			// A database error cannot extend the last confirmed deadline.
		} finally {
			verifying = false;
		}
	}, input.intervalMs);
	return {
		signal: controller.signal,
		revoke,
		stop() {
			stopped = true;
			clearInterval(interval);
			clearTimeout(deadlineTimer);
		},
	};
}

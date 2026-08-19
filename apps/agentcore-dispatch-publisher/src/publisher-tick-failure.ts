/** Preserve telemetry sampled before a publisher operation became uncertain. */
export class PublisherTickFailure extends Error {
	constructor(
		readonly failure: unknown,
		readonly pendingAgeMs: number,
	) {
		super("AgentCore dispatch publisher tick failed", { cause: failure });
		this.name = "PublisherTickFailure";
	}
}

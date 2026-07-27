import { expect, it } from "bun:test";
import type { ArtifactAwareQuery } from "../../artifacts/artifact-publication";
import { withSessionMirrorEvidence } from "./session-mirror-fixtures";

class ClassBackedQuery implements ArtifactAwareQuery {
	#closed = false;
	#interrupted = false;

	get closed(): boolean {
		return this.#closed;
	}

	get interrupted(): boolean {
		return this.#interrupted;
	}

	close(): void {
		this.#closed = true;
	}

	async interrupt(): Promise<void> {
		this.#interrupted = true;
	}

	getArtifactPublication(): null {
		return null;
	}

	async *[Symbol.asyncIterator](): AsyncGenerator<never> {}
}

it("adds evidence without losing class-backed query behavior", async () => {
	const query = new ClassBackedQuery();
	const wrapped = withSessionMirrorEvidence(query, "session-class");

	expect(await Array.fromAsync(wrapped)).toEqual([]);
	await wrapped.interrupt();
	wrapped.close();

	expect(query.interrupted).toBe(true);
	expect(query.closed).toBe(true);
	expect(wrapped.getArtifactPublication()).toBeNull();
	expect(wrapped.sessionEvidence.mirroredMainSessionId()).toBe("session-class");
});

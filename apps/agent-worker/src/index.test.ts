import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("agent-worker production composition", () => {
	it("hard-swaps the synthetic processor for the real SDK query path", () => {
		// The entrypoint is intentionally side-effectful, so importing it would boot
		// external clients. Pin the composition contract in source; Task 9.7 owns
		// the credentialed behavioral smoke against real OpenRouter and E2B.
		const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

		expect(source).toContain("const startRunQuery = createStartRunQuery({");
		expect(source).toContain(
			"const artifactPublisher = createArtifactPublisher({",
		);
		expect(source).toContain("createS3ArtifactObjectStore(config.artifact)");
		expect(source).toContain("artifactPublisher,");
		expect(source).toContain("processor: createSdkRunProcessor({");
		expect(source).toContain("createRedisLiveStreamStore({");
		expect(source).toContain("url: config.redisUrl");
		expect(source).toContain("await liveStreamStore.close()");
		expect(source).not.toContain("liveTextTransport");
		expect(source).not.toContain("syntheticProcessor");
	});
});

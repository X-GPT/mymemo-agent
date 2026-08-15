import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("agent-worker production composition", () => {
	it("hard-swaps the synthetic processor for the real SDK query path", () => {
		// The entrypoint is intentionally side-effectful, so importing it would boot
		// external clients. Pin the composition contract in source; Task 9.7 owns
		// the credentialed behavioral smoke against real OpenRouter and E2B.
		const entrypoint = readFileSync(
			new URL("./index.ts", import.meta.url),
			"utf8",
		);
		const resources = readFileSync(
			new URL("./production-run-resources.ts", import.meta.url),
			"utf8",
		);
		expect(resources).toContain("const startRunQuery = createStartRunQuery({");
		expect(resources).toContain(
			"const artifactPublisher = createArtifactPublisher({",
		);
		expect(resources).toContain("createS3ArtifactObjectStore(config.artifact)");
		expect(resources).toContain("artifactPublisher,");
		expect(resources).toContain("processor: createSdkRunProcessor({");
		expect(resources).toContain("createRedisLiveStreamRelay({");
		expect(resources).toContain("url: config.redisUrl");
		expect(entrypoint).toContain(
			"createProductionRunResources({ config, logger })",
		);
		expect(entrypoint).toContain("await liveStreamRelay.close()");
		expect(entrypoint).not.toContain("liveTextTransport");
		expect(resources).not.toContain("liveTextTransport");
		expect(entrypoint).not.toContain("syntheticProcessor");
		expect(resources).not.toContain("syntheticProcessor");
	});
});

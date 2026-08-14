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
		const source = `${entrypoint}\n${resources}`;

		expect(source).toContain("const startRunQuery = createStartRunQuery({");
		expect(source).toContain(
			"const artifactPublisher = createArtifactPublisher({",
		);
		expect(source).toContain("createS3ArtifactObjectStore(config.artifact)");
		expect(source).toContain("artifactPublisher,");
		expect(source).toContain("processor: createSdkRunProcessor({");
		expect(source).toContain("createRedisLiveStreamRelay({");
		expect(source).toContain("url: config.redisUrl");
		expect(entrypoint).toContain(
			"createProductionRunResources({ config, logger })",
		);
		expect(entrypoint).toContain("await liveStreamRelay.close()");
		expect(source).not.toContain("liveTextTransport");
		expect(source).not.toContain("syntheticProcessor");
	});
});

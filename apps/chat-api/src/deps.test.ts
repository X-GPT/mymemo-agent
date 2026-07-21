import { expect, it } from "bun:test";
import type { ApiConfig } from "./config/env";
import { createDeps } from "./deps";

function config(): ApiConfig {
	return {
		logLevel: "silent",
		databaseUrl: "postgresql://u:p@localhost:5432/mymemo_agent",
		artifactBucket: "mymemo-agent-test-artifacts",
		artifactRegion: "us-west-2",
		statsigServerSecret: "statsig-test",
		agentExposureBreakGlass: false,
		redisUrl: "rediss://default:secret@redis.internal:6379",
	};
}

it("constructs the lazy retained Live Stream reader from required Redis config", async () => {
	const deps = createDeps(config());
	expect(deps.liveStreamReader).toBeDefined();
	expect(deps.closeLiveResources).toBeFunction();
	await deps.closeLiveResources();
});

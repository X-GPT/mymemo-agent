import { expect, it } from "bun:test";
import { disabledLiveTextSubscriber } from "@mymemo/live-text";
import type { ApiConfig } from "./config/env";
import { createDeps } from "./deps";

function config(liveTextRedisUrl: string | undefined): ApiConfig {
	return {
		logLevel: "silent",
		databaseUrl: "postgresql://u:p@localhost:5432/mymemo_agent",
		statsigServerSecret: "statsig-test",
		agentExposureBreakGlass: false,
		liveTextRedisUrl,
	};
}

it("keeps the chat-api Live lane disabled without valid Redis configuration", () => {
	const signals: string[] = [];
	const deps = createDeps(config(undefined), (signal) => signals.push(signal));
	expect(deps.liveTextSubscriber).toBe(disabledLiveTextSubscriber);
	expect(deps.closeLiveText).toBeUndefined();
	expect(signals).toEqual(["disabled"]);
});

it("constructs the lazy production subscriber when Redis is configured", async () => {
	const deps = createDeps(
		config("rediss://default:secret@redis.internal:6379"),
	);
	expect(deps.liveTextSubscriber).not.toBe(disabledLiveTextSubscriber);
	expect(deps.closeLiveText).toBeFunction();
	await deps.closeLiveText?.();
});

import { expect, it } from "bun:test";
import {
	createLiveTextTelemetry,
	disabledLiveTextSubscriber,
} from "@mymemo/live-text";
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
	const signals: Record<string, unknown>[] = [];
	const telemetry = createLiveTextTelemetry("chat-api", {
		info: (event) => signals.push(event),
		warn: (event) => signals.push(event),
	});
	const deps = createDeps(config(undefined), telemetry);
	expect(deps.liveTextSubscriber).toBe(disabledLiveTextSubscriber);
	expect(deps.closeLiveText).toBeUndefined();
	expect(signals).toEqual([
		{
			message: "Live preview signal",
			service: "chat-api",
			signal: "disabled",
			reason: "configuration",
			count: 1,
		},
	]);
});

it("constructs the lazy production subscriber when Redis is configured", async () => {
	const deps = createDeps(
		config("rediss://default:secret@redis.internal:6379"),
	);
	expect(deps.liveTextSubscriber).not.toBe(disabledLiveTextSubscriber);
	expect(deps.closeLiveText).toBeFunction();
	await deps.closeLiveText?.();
});

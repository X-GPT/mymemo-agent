import { describe, expect, it } from "bun:test";
import { envFromRunHookPayload, loadInVmConfigFromEnv } from "./config";

/** A minimal env that loads cleanly. */
function baseEnv(): Record<string, string | undefined> {
	return {
		AGENT_DATABASE_URL: "postgresql://u:p@localhost:5432/mymemo_agent",
		KB_DATABASE_URL: "postgresql://reader:p@localhost:5432/mymemo_kb",
		DB_SSL: "disable",
		REDIS_URL: "rediss://default:secret@redis.internal:6379",
		MYMEMO_USER_ID: "user-1",
		MYMEMO_CONVERSATION_ID: "conversation-1",
		WORKSPACE_DIR: "/workspace",
		MODEL_BASE_URL: "https://openrouter.ai/api",
		MODEL_API_KEY: "sk-test",
		MODEL: "anthropic/claude-sonnet-5",
	};
}

describe("loadInVmConfigFromEnv", () => {
	it("loads a full config with defaults", () => {
		const config = loadInVmConfigFromEnv(baseEnv());
		expect(config.kbDatabaseUrl).toBe(
			"postgresql://reader:p@localhost:5432/mymemo_kb",
		);
		expect(config.userId).toBe("user-1");
		expect(config.conversationId).toBe("conversation-1");
		expect(config.workspaceDir).toBe("/workspace");
		expect(config.model).toEqual({
			baseUrl: "https://openrouter.ai/api",
			apiKey: "sk-test",
			model: "anthropic/claude-sonnet-5",
		});
	});

	it.each([
		"AGENT_DATABASE_URL",
		"KB_DATABASE_URL",
		"MYMEMO_USER_ID",
		"MYMEMO_CONVERSATION_ID",
		"WORKSPACE_DIR",
		"MODEL_BASE_URL",
		"MODEL_API_KEY",
		"MODEL",
	] as const)("refuses to boot without %s", (name) => {
		const env = baseEnv();
		delete env[name];
		expect(() => loadInVmConfigFromEnv(env)).toThrow(new RegExp(name));
	});

	it("reads the writable agent DB from AGENT_DATABASE_URL, not DATABASE_URL", () => {
		const env = baseEnv();
		env.DATABASE_URL = "postgresql://kb:kb@localhost:5432/mymemo_kb";
		const config = loadInVmConfigFromEnv(env);
		expect(config.databaseUrl).toContain("mymemo_agent");
		expect(config.databaseUrl).not.toContain("mymemo_kb");
	});

	it("trims trailing slashes off the model base URL", () => {
		const env = baseEnv();
		env.MODEL_BASE_URL = "https://openrouter.ai/api///";
		expect(loadInVmConfigFromEnv(env).model.baseUrl).toBe(
			"https://openrouter.ai/api",
		);
	});

	it("refuses an insecure Redis URL unless the local escape hatch is set", () => {
		const env = baseEnv();
		env.REDIS_URL = "redis://127.0.0.1:6379";
		expect(() => loadInVmConfigFromEnv(env)).toThrow();
		env.LIVE_STREAM_ALLOW_INSECURE_LOCAL_REDIS = "true";
		expect(loadInVmConfigFromEnv(env).redisUrl).toBe("redis://127.0.0.1:6379");
	});
});

describe("envFromRunHookPayload", () => {
	it("parses a JSON object of env-shaped keys, loadable by loadInVmConfigFromEnv", () => {
		const payload = JSON.stringify(baseEnv());
		const config = loadInVmConfigFromEnv(envFromRunHookPayload(payload));
		expect(config.conversationId).toBe("conversation-1");
	});

	it.each([
		[undefined, /runHookPayload is required/],
		["", /runHookPayload is required/],
		["not json", /not valid JSON/],
		['"a string"', /JSON object/],
		["[1,2]", /JSON object/],
		['{"PORT":8080}', /must be a string/],
	] as const)("rejects %p", (payload, message) => {
		expect(() => envFromRunHookPayload(payload)).toThrow(message);
	});
});

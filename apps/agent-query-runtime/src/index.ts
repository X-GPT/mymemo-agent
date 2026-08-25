import { mkdir } from "node:fs/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createAgentQueryServerOptions } from "./server";

const port = Number(Bun.env.PORT ?? 8080);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
	throw new Error("PORT must be an integer between 1 and 65535");
}

Bun.serve(
	createAgentQueryServerOptions(
		{
			query,
			async prepareWorkingDirectory(path) {
				await mkdir(path, { recursive: true });
			},
			// Production Postgres epoch/deadline enforcement is composed in #565;
			// this Runtime remains outside production until then.
			async verifyResponseAuthority() {},
		},
		port,
	),
);

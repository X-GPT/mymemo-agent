import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import { readOpenRouterKey } from "./config";
import { createRuntimeServer } from "./runtime";

const require = createRequire(import.meta.url);
const sdk = require.resolve("claude-agent-sdk");
// Resolve from this SDK, not v1's older version; the image uses glibc, not musl.
const executable = require.resolve(
	`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`,
	{ paths: [dirname(sdk)] },
);
execFileSync(executable, ["--version"], { stdio: "ignore" });
const token = await readOpenRouterKey(process.env);
const codeInterpreterId = process.env.CODE_INTERPRETER_ID;
if (!codeInterpreterId) throw new Error("CODE_INTERPRETER_ID is required");
const bucket = process.env.WORKSPACE_BUCKET;
if (!bucket) throw new Error("WORKSPACE_BUCKET is required");
createRuntimeServer({
	codeInterpreterId,
	s3: new S3Client({}),
	bucket,
	model: process.env.OPENROUTER_DEFAULT_MODEL ?? "anthropic/claude-sonnet-5",
	env: {
		...process.env,
		ANTHROPIC_BASE_URL:
			process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api",
		ANTHROPIC_AUTH_TOKEN: token,
		ANTHROPIC_API_KEY: "",
	},
	pathToClaudeCodeExecutable: executable,
	port: Number(process.env.PORT ?? 8080),
});

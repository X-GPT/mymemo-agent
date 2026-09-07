import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { createRuntimeServer } from "./runtime";

const require = createRequire(import.meta.url);
const sdk = require.resolve("claude-agent-sdk");
// Resolve from this SDK, not v1's older version; the image uses glibc, not musl.
const executable = require.resolve(
	`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`,
	{ paths: [dirname(sdk)] },
);
execFileSync(executable, ["--version"], { stdio: "ignore" });
const token = process.env.OPENROUTER_API_KEY;
if (!token) throw new Error("OPENROUTER_API_KEY is required");
const codeInterpreterId = process.env.CODE_INTERPRETER_ID;
if (!codeInterpreterId) throw new Error("CODE_INTERPRETER_ID is required");
createRuntimeServer({
	codeInterpreterId,
	model: process.env.OPENROUTER_DEFAULT_MODEL ?? "anthropic/claude-sonnet-5",
	env: {
		...process.env,
		ANTHROPIC_BASE_URL:
			process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api",
		ANTHROPIC_AUTH_TOKEN: token,
		ANTHROPIC_API_KEY: "",
	},
	pathToClaudeCodeExecutable: executable,
	cwd: "/opt/mymemo/project",
	port: Number(process.env.PORT ?? 8080),
});

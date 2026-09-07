// Two Turns on fresh Runtime sessions, with the first Turn's random fact recalled.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const conversationId = crypto.randomUUID();
const fact = crypto.randomUUID();
const runtimeArn = process.env.AGENT_RUNTIME_ARN;
const workDir = await mkdtemp(join(tmpdir(), "runtime-memory-smoke-"));
try {
	for (const [index, text] of [
		`Remember this exact secret code for this conversation: ${fact}. Reply with just OK.`,
		"What exact secret code did I give you in my previous message? Reply with just the code.",
	].entries()) {
		const turnId = crypto.randomUUID();
		const now = Date.now();
		const payload = JSON.stringify({
			conversationId,
			turnId,
			seq: index + 1,
			requestId: turnId,
			userId: "runtime-smoke",
			scope: { kind: "general" },
			text,
			startedAt: now,
			budgetUntil: now + 720_000,
			sandboxSessionId: "unused-no-tools",
		});
		let ndjson: string;
		if (runtimeArn) {
			const output = join(workDir, `${turnId}.ndjson`);
			execFileSync(
				"aws",
				[
					"--profile",
					"mymemo",
					"--region",
					"us-west-2",
					"bedrock-agentcore",
					"invoke-agent-runtime",
					"--agent-runtime-arn",
					runtimeArn,
					"--qualifier",
					"DEFAULT",
					"--runtime-session-id",
					turnId,
					"--content-type",
					"application/json",
					"--accept",
					"application/x-ndjson",
					"--cli-binary-format",
					"raw-in-base64-out",
					"--payload",
					payload,
					"--cli-read-timeout",
					"180",
					output,
				],
				{ stdio: ["ignore", "ignore", "inherit"] },
			);
			ndjson = await readFile(output, "utf8");
		} else {
			const response = await fetch(
				`${process.env.RUNTIME_URL ?? "http://localhost:8080"}/invocations`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: payload,
					signal: AbortSignal.timeout(180_000),
				},
			);
			assert(response.ok, `Runtime returned ${response.status}`);
			ndjson = await response.text();
		}
		const messages = ndjson
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const result = messages.at(-1);
		assert(
			result?.type === "result" && !result.is_error,
			JSON.stringify(result),
		);
		assert.equal(result.session_id, conversationId);
		if (index === 1)
			assert(
				String(result.result).includes(fact),
				"Turn 2 did not recall Turn 1",
			);
		console.log(
			JSON.stringify({
				conversationId,
				turnId,
				seq: index + 1,
				result: result.result,
			}),
		);
	}
} finally {
	await rm(workDir, { recursive: true, force: true });
}

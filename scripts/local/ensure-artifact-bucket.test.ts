import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("local Downloadable artifact bucket bootstrap", () => {
	it("creates a missing private bucket once and reapplies its seven-day lifecycle idempotently", async () => {
		const fakeBin = await mkdtemp(join(tmpdir(), "mymemo-local-aws-"));
		temporaryDirectories.push(fakeBin);
		const callLog = join(fakeBin, "calls.log");
		const bucketState = join(fakeBin, "bucket-exists");
		const fakeAws = join(fakeBin, "aws");
		await writeFile(
			fakeAws,
			`#!/bin/sh
printf '%s\n' "$*" >> "$AWS_CALL_LOG"
case "$1 $2" in
  "s3api head-bucket")
    test -f "$AWS_BUCKET_STATE"
    ;;
  "s3api create-bucket")
    : > "$AWS_BUCKET_STATE"
    ;;
esac
`,
		);
		await chmod(fakeAws, 0o755);

		const env = {
			...process.env,
			ARTIFACT_BUCKET: "mymemo-agent-local-artifacts",
			AWS_BUCKET_STATE: bucketState,
			AWS_CALL_LOG: callLog,
			AWS_REGION: "us-west-2",
			PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
		};
		const script = join(root, "scripts/local/ensure-artifact-bucket.sh");

		for (let run = 0; run < 2; run += 1) {
			const child = Bun.spawn(["/bin/sh", script], {
				cwd: root,
				env,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stderr] = await Promise.all([
				child.exited,
				new Response(child.stderr).text(),
			]);
			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
		}

		const calls = (await readFile(callLog, "utf8")).trim().split("\n");
		expect(
			calls.filter((call) => call.startsWith("s3api create-bucket ")),
		).toHaveLength(1);
		expect(
			calls.filter((call) => call.startsWith("s3api put-public-access-block ")),
		).toHaveLength(2);
		expect(
			calls.filter((call) =>
				call.startsWith("s3api put-bucket-ownership-controls "),
			),
		).toHaveLength(2);
		expect(
			calls.filter((call) =>
				call.startsWith("s3api put-bucket-lifecycle-configuration "),
			),
		).toHaveLength(2);

		const lifecycle = JSON.parse(
			await readFile(
				join(root, "scripts/local/artifact-bucket-lifecycle.json"),
				"utf8",
			),
		) as { Rules?: Array<{ Expiration?: { Days?: number } }> };
		expect(lifecycle.Rules?.[0]?.Expiration?.Days).toBe(7);
	});
});

describe("local split-runtime Compose harness", () => {
	it("boots both trusted runtimes only after configuring artifact storage with developer AWS credentials", async () => {
		const compose = await readFile(join(root, "compose.yaml"), "utf8");
		const composeHome = "$" + "{HOME}";
		const composeInterpolation = "$" + "{";
		const config = Bun.YAML.parse(compose) as ComposeConfig;
		const awsEnvironment = config["x-artifact-aws-environment"];
		const chatApi = requiredService(config, "chat-api");
		const worker = requiredService(config, "agent-worker");
		const bucketBootstrap = requiredService(config, "artifact-bucket");

		expect(awsEnvironment).toEqual({
			ARTIFACT_BUCKET: "mymemo-agent-local-artifacts",
			AWS_REGION: "us-west-2",
			AWS_PROFILE: `${composeInterpolation}AWS_PROFILE:-}`,
			AWS_ACCESS_KEY_ID: `${composeInterpolation}AWS_ACCESS_KEY_ID:-}`,
			AWS_SECRET_ACCESS_KEY: `${composeInterpolation}AWS_SECRET_ACCESS_KEY:-}`,
			AWS_SESSION_TOKEN: `${composeInterpolation}AWS_SESSION_TOKEN:-}`,
		});
		for (const trustedRuntime of [chatApi, worker]) {
			expect(trustedRuntime.environment).toMatchObject(awsEnvironment);
			expect(trustedRuntime.volumes).toContain(
				`${composeHome}/.aws:/home/bun/.aws:ro`,
			);
			expect(trustedRuntime.depends_on?.["artifact-bucket"]).toEqual({
				condition: "service_completed_successfully",
			});
		}
		expect(bucketBootstrap.image).toBe("amazon/aws-cli:2");
		expect(bucketBootstrap.entrypoint).toEqual([
			"/bin/sh",
			"/local/ensure-artifact-bucket.sh",
		]);
		expect(bucketBootstrap.environment).toEqual(awsEnvironment);
		expect(bucketBootstrap.volumes).toContain(
			`${composeHome}/.aws:/root/.aws:ro`,
		);
	});
});

describe("local harness operator documentation", () => {
	it("documents the provider, sandbox, AWS credential, bucket, and gate-open smoke prerequisites", async () => {
		const readme = await readFile(join(root, "README.md"), "utf8");

		for (const prerequisite of [
			"OPENROUTER_API_KEY",
			"E2B_API_KEY",
			"AWS_PROFILE",
			"AWS_ACCESS_KEY_ID",
			"AWS_SECRET_ACCESS_KEY",
			"mymemo-agent-local-artifacts",
			"seven days",
			"AGENT_SMOKE_EXPECT_GATE_CLOSED=false",
		]) {
			expect(readme).toContain(prerequisite);
		}
		expect(readme).toMatch(/AWS credentials[\s\S]*trusted runtimes/i);
		expect(readme).toMatch(/AWS credentials[\s\S]*not[\s\S]*E2B sandbox/i);
	});
});

interface ComposeService {
	image?: string;
	entrypoint?: string[];
	environment?: Record<string, string>;
	volumes?: string[];
	depends_on?: Record<string, { condition?: string }>;
}

interface ComposeConfig {
	"x-artifact-aws-environment": Record<string, string>;
	services: Record<string, ComposeService>;
}

function requiredService(config: ComposeConfig, name: string): ComposeService {
	const service = config.services[name];
	if (!service) throw new Error(`compose service ${name} is missing`);
	return service;
}

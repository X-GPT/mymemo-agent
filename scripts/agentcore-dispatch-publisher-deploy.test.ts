import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");

describe("AgentCore dispatch publisher deployment", () => {
	it("is a dedicated workspace app, not an agent-worker entrypoint", () => {
		const appDir = join(root, "apps", "agentcore-dispatch-publisher");
		const workerPackage = read("apps", "agent-worker", "package.json");
		const workerDockerfile = read("apps", "agent-worker", "Dockerfile");

		expect(existsSync(join(appDir, "package.json"))).toBe(true);
		expect(existsSync(join(appDir, "src", "main.ts"))).toBe(true);
		expect(existsSync(join(appDir, "Dockerfile"))).toBe(true);
		expect(
			existsSync(
				join(root, "apps", "agent-worker", "src", "agentcore-dispatch"),
			),
		).toBe(false);
		expect(workerPackage).not.toContain("start:agentcore-publisher");
		expect(workerPackage).not.toContain("agentcore-canary-dispatch");
		expect(workerPackage).not.toContain("@aws-sdk/client-sqs");
		expect(workerPackage).not.toContain("@aws-sdk/client-ssm");
		expect(workerDockerfile).not.toContain("apps/agentcore-canary-dispatch");
	});

	it("builds and publishes an independent image", () => {
		const ecr = read("infra", "ecr", "main.tf");
		const ecrOutputs = read("infra", "ecr", "outputs.tf");
		const build = read("scripts", "deploy", "build_and_push_agent_image.sh");
		const release = read(".github", "workflows", "release-deploy.yml");
		const dockerfile = read(
			"apps",
			"agentcore-dispatch-publisher",
			"Dockerfile",
		);

		expect(ecr).toContain(
			'resource "aws_ecr_repository" "agentcore_dispatch_publisher"',
		);
		expect(ecr).toContain(
			'name                 = "mymemo-agentcore-dispatch-publisher"',
		);
		expect(ecrOutputs).toContain(
			'output "agentcore_dispatch_publisher_ecr_repository_url"',
		);
		expect(build).toContain("agentcore-dispatch-publisher)");
		expect(build).toContain(
			'dockerfile="apps/agentcore-dispatch-publisher/Dockerfile"',
		);
		expect(release).toContain(
			"build_and_push_agent_image.sh agentcore-dispatch-publisher",
		);
		expect(release).toContain("agentcore_dispatch_publisher_image");
		expect(dockerfile).toContain(
			"bun install --frozen-lockfile --production --filter agentcore-dispatch-publisher",
		);
	});

	it("runs one publisher task with only database and dispatch authority", () => {
		const ecs = read("infra", "terraform", "ecs.tf");
		const iam = read("infra", "terraform", "iam.tf");
		const locals = read("infra", "terraform", "locals.tf");
		const prod = read("infra", "terraform", "prod.tfvars");

		expect(ecs).toContain(
			'resource "aws_ecs_task_definition" "agentcore_dispatch_publisher"',
		);
		expect(ecs).toContain(
			'resource "aws_ecs_service" "agentcore_dispatch_publisher"',
		);
		expect(ecs).toContain(
			"desired_count   = var.agentcore_dispatch_publisher_desired_count",
		);
		expect(prod).toContain("agentcore_dispatch_publisher_desired_count = 1");
		expect(iam).toContain(
			'resource "aws_iam_role" "agentcore_dispatch_publisher_task"',
		);
		expect(iam).toContain('actions   = ["ssm:GetParameter"]');
		expect(iam).toContain('"sqs:SendMessage"');
		expect(iam).toContain('"kms:GenerateDataKey"');
		expect(locals).toContain("agentcore_dispatch_publisher_environment");
		expect(locals).toContain('{ name = "CANARY_DISPATCH_QUEUE_URL"');
		expect(locals).toContain('{ name = "CANARY_ENABLED_PARAMETER_NAME"');
		expect(locals).not.toMatch(
			/agentcore_dispatch_publisher_(?:environment|secrets)[\s\S]*?(?:KB_DATABASE_URL|OPENROUTER|E2B|ARTIFACT_BUCKET|REDIS_URL)/,
		);
	});
});

import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

interface ComposeService {
	environment?: Record<string, string>;
	volumes?: string[];
	depends_on?: Record<string, { condition?: string }>;
}

interface ComposeConfig {
	"x-artifact-aws-environment": Record<string, string>;
	services: Record<string, ComposeService>;
}

describe("local artifact infrastructure", () => {
	it("owns the fixed private seven-day bucket in separate dev Terraform state", async () => {
		const [artifacts, versions] = await Promise.all([
			readFile(join(root, "infra/dev/artifacts.tf"), "utf8"),
			readFile(join(root, "infra/dev/versions.tf"), "utf8"),
		]);

		expect(versions).toContain('key          = "mymemo-agent/dev.tfstate"');
		expect(versions).not.toContain("prod.tfstate");
		expect(artifacts).toContain('bucket = "mymemo-agent-local-artifacts"');
		expect(artifacts).toMatch(
			/resource "aws_s3_bucket_public_access_block" "artifacts"[\s\S]*?block_public_acls\s*=\s*true[\s\S]*?block_public_policy\s*=\s*true[\s\S]*?ignore_public_acls\s*=\s*true[\s\S]*?restrict_public_buckets\s*=\s*true/,
		);
		expect(artifacts).toMatch(
			/resource "aws_s3_bucket_ownership_controls" "artifacts"[\s\S]*?object_ownership\s*=\s*"BucketOwnerEnforced"/,
		);
		expect(artifacts).toMatch(
			/resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts"[\s\S]*?sse_algorithm\s*=\s*"AES256"/,
		);
		expect(artifacts).toMatch(
			/resource "aws_s3_bucket_lifecycle_configuration" "artifacts"[\s\S]*?id\s*=\s*"expire-local-artifacts"[\s\S]*?expiration[\s\S]*?days\s*=\s*7[\s\S]*?abort_incomplete_multipart_upload[\s\S]*?days_after_initiation\s*=\s*1/,
		);
		expect(artifacts).toContain('variable = "aws:SecureTransport"');
	});

	it("participates in the repository Terraform checks", async () => {
		const packageConfig = JSON.parse(
			await readFile(join(root, "package.json"), "utf8"),
		) as { scripts?: Record<string, string> };

		expect(packageConfig.scripts?.["terraform:fmt"]).toContain(
			"terraform -chdir=infra/dev fmt",
		);
		expect(packageConfig.scripts?.["terraform:validate"]).toContain(
			"terraform -chdir=infra/dev validate",
		);
	});
});

describe("local split-runtime Compose harness", () => {
	it("uses Terraform-owned artifact storage without provisioning AWS resources", async () => {
		const compose = Bun.YAML.parse(
			await readFile(join(root, "compose.yaml"), "utf8"),
		) as ComposeConfig;
		const awsEnvironment = compose["x-artifact-aws-environment"];
		const composeHome = "$" + "{HOME}";

		expect(awsEnvironment.ARTIFACT_BUCKET).toBe("mymemo-agent-local-artifacts");
		expect(compose.services["artifact-bucket"]).toBeUndefined();
		for (const name of ["chat-api", "agent-worker"]) {
			const service = compose.services[name];
			expect(service?.environment).toMatchObject(awsEnvironment);
			expect(service?.volumes).toContain(
				`${composeHome}/.aws:/home/bun/.aws:ro`,
			);
			expect(service?.depends_on?.["artifact-bucket"]).toBeUndefined();
		}
	});
});

describe("local harness operator documentation", () => {
	it("documents Terraform provisioning before the gate-open smoke", async () => {
		const readme = await readFile(join(root, "README.md"), "utf8");

		expect(readme).toContain("terraform -chdir=infra/dev init");
		expect(readme).toContain("terraform -chdir=infra/dev apply");
		expect(readme).toContain("mymemo-agent-local-artifacts");
		expect(readme).toContain("seven days");
		expect(readme).toContain("docker compose up --build");
		expect(readme).toContain("AGENT_SMOKE_EXPECT_GATE_CLOSED=false");
		expect(readme).not.toContain("`artifact-bucket` service");
	});
});

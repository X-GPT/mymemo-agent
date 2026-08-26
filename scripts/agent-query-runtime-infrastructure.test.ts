import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

function section(source: string, start: string, end: string): string {
	const startIndex = source.indexOf(start);
	const endIndex = source.indexOf(end, startIndex + start.length);
	expect(startIndex).toBeGreaterThanOrEqual(0);
	expect(endIndex).toBeGreaterThan(startIndex);
	return source.slice(startIndex, endIndex);
}

describe("agent-query Runtime infrastructure", () => {
	it("supplies the bucket with prefix-scoped production IAM", () => {
		const queryRuntimePolicy = section(
			readFileSync("infra/terraform/agentcore-iam.tf", "utf8"),
			'data "aws_iam_policy_document" "query_runtime"',
			'resource "aws_iam_role_policy" "query_runtime"',
		);
		const queryRuntimeEnvironment = section(
			readFileSync("infra/terraform/agentcore-locals.tf", "utf8"),
			"query_runtime_environment = {",
			"lambda_common_environment = {",
		);

		expect(queryRuntimeEnvironment).toContain("ARTIFACT_BUCKET");
		expect(queryRuntimeEnvironment).toContain("aws_s3_bucket.artifacts.bucket");
		expect(queryRuntimePolicy).toContain('"s3:GetObject"');
		expect(queryRuntimePolicy).toContain('"s3:PutObject"');
		expect(queryRuntimePolicy).toContain("/agent-sessions/*");
		expect(queryRuntimePolicy).not.toContain("/objects/*");
		expect(queryRuntimePolicy).not.toContain("s3:ListBucket");
		expect(queryRuntimePolicy).not.toContain("s3:DeleteObject");
		expect(queryRuntimePolicy).not.toContain("s3:AbortMultipartUpload");
	});

	it("keeps local and deployment verification authority narrow", () => {
		const compose = readFileSync("compose.yaml", "utf8");
		const localPolicy = JSON.parse(
			readFileSync("infra/dev/agent-session-policy.json", "utf8"),
		);
		const verifyRuntime = section(
			readFileSync("infra/bootstrap-iam/main.tf", "utf8"),
			'sid = "VerifyAgentQueryRuntime"',
			'sid = "AgentCoreConsumerManagement"',
		);

		expect(compose).toContain("agent-session-policy.json");
		expect(compose).toContain(
			"mc admin policy attach local agent-session --user local-agent-session",
		);
		expect(compose).not.toContain(
			"mc admin policy attach local readwrite --user local-agent-session",
		);
		expect(localPolicy.Statement).toEqual([
			{
				Effect: "Allow",
				Action: ["s3:GetObject", "s3:PutObject"],
				Resource: "arn:aws:s3:::mymemo-agent-local-artifacts/agent-sessions/*",
			},
		]);
		expect(verifyRuntime).toContain("bedrock-agentcore:InvokeAgentRuntime");
		expect(verifyRuntime).toContain("bedrock-agentcore:StopRuntimeSession");
	});
});

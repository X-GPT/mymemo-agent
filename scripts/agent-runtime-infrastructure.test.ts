import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

test("simplified Runtime authority excludes state, workspace, and sandbox lifecycle", () => {
	const policy = read("infra/terraform/agent-runtime-iam.tf");
	const actions = [...policy.matchAll(/actions\s*=\s*\[([^\]]+)\]/g)]
		.flatMap((match) => [
			...match[1].matchAll(
				/"((?:s3|bedrock-agentcore|secretsmanager|dynamodb):[^"]+)"/g,
			),
		])
		.map((match) => match[1]);
	expect(actions.sort()).toEqual([
		"bedrock-agentcore:GetCodeInterpreterSession",
		"bedrock-agentcore:InvokeCodeInterpreter",
		"s3:GetObject",
		"s3:PutObject",
		"secretsmanager:GetSecretValue",
	]);
	expect(policy).toContain(`\${aws_s3_bucket.workspace.arn}/_transcripts/*`);
	expect(policy).toContain(
		"aws_bedrockagentcore_code_interpreter.hand.code_interpreter_arn",
	);
	expect(policy).toContain('values   = ["AWSCURRENT"]');
	const runtime = read("infra/terraform/agent-runtime.tf");
	expect(runtime).toContain(
		"security_groups = [aws_security_group.runtime.id]",
	);
	expect(runtime).toContain(
		"subnets         = values(aws_subnet.private)[*].id",
	);
	expect(runtime).toContain(`@\${var.agent_runtime_image_digest}`);
	expect(runtime).not.toContain("aws_security_group.services");
});

test("release carries the new digest through both jobs", () => {
	const workflow = read(".github/workflows/release-deploy.yml");
	for (const expected of [
		"--file apps/agent-runtime/Dockerfile",
		`TF_VAR_agent_runtime_image_digest: \${{ needs.plan.outputs.agent_runtime_image_digest }}`,
		`agent_runtime_image_digest: \${{ steps.agent_runtime_image.outputs.digest }}`,
		"TF_VAR_agent_runtime_image_digest=%s",
		"--platform linux/arm64",
	])
		expect(workflow).toContain(expected);
});

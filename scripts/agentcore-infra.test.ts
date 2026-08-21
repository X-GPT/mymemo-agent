import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTCORE_DISPATCH_QUEUE_INVARIANTS } from "../apps/agentcore-dispatch-consumer/src/invariants";

const root = process.cwd();
const terraformDir = join(root, "infra", "terraform");
const ecrTerraformDir = join(root, "infra", "ecr");
const terraformEnvironment = "$" + "{var.environment}";

function terraformFiles(): string[] {
	if (!existsSync(terraformDir)) return [];
	return readdirSync(terraformDir, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".tf"))
		.map((entry) => join(terraformDir, entry.name));
}

function terraformSource(): string {
	return terraformFiles()
		.map((path) => readFileSync(path, "utf8"))
		.join("\n");
}

describe("production AgentCore dispatch infrastructure", () => {
	it("builds the Runtime on updated packages and ships a non-root distroless release", () => {
		const dockerfile = readFileSync(
			join(root, "apps", "agentcore-runtime", "Dockerfile"),
			"utf8",
		);

		expect(dockerfile).toContain("apt-get update");
		expect(dockerfile).toContain("apt-get upgrade -y --no-install-recommends");
		expect(dockerfile).toContain("rm -rf /var/lib/apt/lists/*");
		expect(dockerfile).toMatch(/^ARG BUN_VERSION=1$/m);
		expect(dockerfile).toContain(
			`FROM oven/bun:\${BUN_VERSION}-distroless AS release`,
		);
		expect(dockerfile).toContain(
			'AS release\nLABEL com.mymemo.agentcore-runtime.request-oriented="true"\nWORKDIR /usr/src/app',
		);
		expect(dockerfile).toContain("USER 65532:65532");
		expect(dockerfile.indexOf("apt-get update")).toBeLessThan(
			dockerfile.indexOf("AS release"),
		);
	});

	it("uses the unified production state and current AWS provider", () => {
		const versions = readFileSync(join(terraformDir, "versions.tf"), "utf8");

		const retiredDir = join(root, "infra", "agentcore");
		expect(existsSync(retiredDir)).toBe(false);
		expect(versions).toContain('key          = "mymemo-agent/prod.tfstate"');
		expect(versions).toMatch(/use_lockfile\s*=\s*true/);
		expect(versions).toMatch(/encrypt\s*=\s*true/);
		expect(versions).toMatch(/version\s*=\s*">= 6\.50, < 7\.0"/);
		expect(existsSync(join(terraformDir, ".terraform.lock.hcl"))).toBe(true);
	});

	it("owns ECS and AgentCore in one root without the retired publisher Lambda", () => {
		const source = terraformSource();

		expect(source).toContain('resource "aws_ecs_service" "agent_worker"');
		expect(source).toContain(
			'resource "aws_bedrockagentcore_agent_runtime" "runtime"',
		);
		expect(source).not.toContain(
			'data "terraform_remote_state" "mymemo_agent"',
		);
		expect(source).not.toContain('resource "aws_lambda_function" "publisher"');
		expect(source).not.toContain('resource "aws_iam_role" "publisher"');
		expect(source).not.toContain(
			'resource "aws_cloudwatch_event_rule" "repair"',
		);
		expect(source).not.toContain(
			'resource "aws_cloudwatch_event_target" "repair"',
		);
		expect(source).not.toContain('resource "aws_lambda_permission" "repair"');
	});

	it("consumes the dedicated production publisher service contract without granting it to agent-worker", () => {
		const sharedLocals = readFileSync(
			join(root, "infra", "terraform", "locals.tf"),
			"utf8",
		);
		const sharedIam = readFileSync(
			join(root, "infra", "terraform", "iam.tf"),
			"utf8",
		);
		const productionValues = readFileSync(
			join(root, "infra", "terraform", "prod.tfvars"),
			"utf8",
		);

		expect(sharedLocals).toContain(
			`"mymemo-agent-agentcore-${terraformEnvironment}-dispatch"`,
		);
		expect(sharedLocals).toContain(
			`"alias/mymemo-agent-agentcore-${terraformEnvironment}"`,
		);
		expect(sharedLocals).toContain(
			`"/mymemo/agentcore-dispatch/${terraformEnvironment}/enabled"`,
		);
		expect(productionValues).toMatch(
			/agentcore_dispatch_publisher_desired_count\s*=\s*1/,
		);

		const workerPolicy = sharedIam.match(
			/data\s+"aws_iam_policy_document"\s+"agent_worker_artifact_write"([\s\S]*?)resource\s+"aws_iam_role_policy"\s+"agent_worker_artifact_write"/,
		)?.[1];
		expect(workerPolicy).toBeDefined();
		expect(workerPolicy).not.toMatch(/sqs:|ssm:|kms:/);
	});

	it("matches every shared queue invariant represented in Terraform", () => {
		const source = terraformSource();
		const queue = AGENTCORE_DISPATCH_QUEUE_INVARIANTS;

		expect(queue.queueType).toBe("standard");
		expect(source).toMatch(
			new RegExp(
				`resource\\s+"aws_sqs_queue"\\s+"dispatch"[\\s\\S]*?message_retention_seconds\\s*=\\s*${queue.retentionSeconds}[\\s\\S]*?visibility_timeout_seconds\\s*=\\s*${queue.visibilityTimeoutSeconds}[\\s\\S]*?kms_master_key_id\\s*=\\s*aws_kms_key\\.dispatch\\.arn`,
			),
		);
		expect(source).not.toContain("sqs_managed_sse_enabled");
		expect(source).toMatch(
			new RegExp(`maxReceiveCount\\s*=\\s*${queue.maxReceiveCount}`),
		);
		expect(source).toMatch(
			new RegExp(
				`resource\\s+"aws_lambda_function"\\s+"consumer"[\\s\\S]*?timeout\\s*=\\s*${queue.consumerTimeoutSeconds}`,
			),
		);
		expect(source).toMatch(
			new RegExp(
				`resource\\s+"aws_lambda_event_source_mapping"\\s+"consumer"[\\s\\S]*?batch_size\\s*=\\s*${queue.consumerBatchSize}[\\s\\S]*?function_response_types\\s*=\\s*\\["ReportBatchItemFailures"\\][\\s\\S]*?enabled\\s*=\\s*true`,
			),
		);
		expect(source).not.toContain("reserved_concurrent_executions");
	});

	it("provides a zonal NAT egress path for every private Runtime subnet", () => {
		const network = readFileSync(
			join(terraformDir, "agentcore-network.tf"),
			"utf8",
		);
		const outputs = readFileSync(
			join(terraformDir, "agentcore-outputs.tf"),
			"utf8",
		);

		expect(network).toMatch(
			/resource\s+"aws_eip"\s+"egress"[\s\S]*?for_each\s*=\s*local\.private_subnets[\s\S]*?domain\s*=\s*"vpc"/,
		);
		expect(network).toMatch(
			/resource\s+"aws_nat_gateway"\s+"egress"[\s\S]*?for_each\s*=\s*local\.private_subnets[\s\S]*?subnet_id\s*=\s*one\(local\.shared_public_subnet_ids_by_az\[each\.key\]\)/,
		);
		expect(network).toMatch(
			/resource\s+"aws_route"\s+"private_egress"[\s\S]*?for_each\s*=\s*local\.private_subnets[\s\S]*?destination_cidr_block\s*=\s*"0\.0\.0\.0\/0"[\s\S]*?nat_gateway_id\s*=\s*aws_nat_gateway\.egress\[each\.key\]\.id/,
		);
		expect(network).toContain("condition     = var.assign_public_ip");
		expect(outputs).toContain('output "egress_configurations"');
	});

	it("deploys production-named Runtime resources from the agent-worker configuration", () => {
		const source = terraformSource();
		const runtime = readFileSync(
			join(terraformDir, "agentcore-runtime.tf"),
			"utf8",
		);
		const ecr = readFileSync(join(ecrTerraformDir, "main.tf"), "utf8");
		const ecrOutputs = readFileSync(
			join(ecrTerraformDir, "outputs.tf"),
			"utf8",
		);
		const variables = readFileSync(join(terraformDir, "variables.tf"), "utf8");
		const agentOutputs = readFileSync(
			join(root, "infra", "terraform", "outputs.tf"),
			"utf8",
		);

		expect(source).toContain(
			'resource "aws_bedrockagentcore_agent_runtime" "runtime"',
		);
		expect(source).toContain(
			`agent_runtime_name    = "mymemo_agentcore_${terraformEnvironment}"`,
		);
		expect(source).toContain(
			`agentcore_name_prefix = "mymemo-agent-agentcore-${terraformEnvironment}"`,
		);
		expect(ecr).toMatch(
			/resource\s+"aws_ecr_repository"\s+"agentcore_runtime"[\s\S]*?name\s*=\s*"mymemo\/agentcore-runtime"[\s\S]*?image_tag_mutability\s*=\s*"IMMUTABLE"[\s\S]*?force_delete\s*=\s*false[\s\S]*?scan_on_push\s*=\s*true[\s\S]*?encryption_type\s*=\s*"AES256"[\s\S]*?prevent_destroy\s*=\s*true/,
		);
		expect(ecrOutputs).toMatch(
			/output\s+"agentcore_runtime_ecr_repository_url"[\s\S]*?aws_ecr_repository\.agentcore_runtime\.repository_url/,
		);
		expect(runtime).toMatch(
			/data\s+"aws_ecr_repository"\s+"production_runtime"[\s\S]*?name\s*=\s*"mymemo\/agentcore-runtime"/,
		);
		expect(runtime).toMatch(
			/removed\s*\{[\s\S]*?from\s*=\s*aws_ecr_repository\.production_runtime[\s\S]*?destroy\s*=\s*false/,
		);
		expect(runtime).not.toContain(
			'resource "aws_ecr_repository" "legacy_runtime"',
		);
		expect(variables).not.toContain(
			'variable "retain_legacy_runtime_repository"',
		);
		expect(variables).not.toContain('variable "runtime_repository_name"');
		expect(variables).not.toContain(
			'variable "runtime_repository_force_delete"',
		);
		expect(source).toMatch(
			/container_uri\s*=\s*"\$\{data\.aws_ecr_repository\.production_runtime\.repository_url\}@\$\{var\.runtime_image_digest\}"/,
		);
		expect(source).toMatch(/network_mode\s*=\s*"VPC"/);
		expect(source).toMatch(/server_protocol\s*=\s*"HTTP"/);
		expect(source).toMatch(/max_lifetime\s*=\s*3600/);
		expect(source).toMatch(
			/resource\s+"aws_bedrockagentcore_agent_runtime"\s+"runtime"[\s\S]*?precondition[\s\S]*?local\.exact_secret_arn_pattern/,
		);
		for (const name of [
			"AGENT_DATABASE_URL",
			"DB_PASSWORD_SECRET_ARN",
			"KB_DATABASE_URL_SECRET_ARN",
			"OPENROUTER_API_KEY_SECRET_ARN",
			"E2B_API_KEY_SECRET_ARN",
			"REDIS_URL_SECRET_ARN",
		]) {
			expect(source).toContain(name);
		}
		expect(agentOutputs).toContain('output "agent_database_url"');
		expect(source).not.toContain("data.terraform_remote_state.mymemo_agent");
		expect(source).toContain("local.agent_db_password_base_secret_arn");
		expect(source).toContain("aws_s3_bucket.artifacts.bucket");
		for (const variable of [
			"agent_database_url_secret_arn",
			"kb_database_url_secret_arn",
			"openrouter_api_key_secret_arn",
			"e2b_api_key_secret_arn",
			"redis_url_secret_arn",
			"artifact_bucket_name",
		]) {
			expect(variables).not.toContain(`variable "${variable}"`);
		}
		for (const forbiddenSecret of [
			"DB_PASSWORD",
			"KB_DATABASE_URL",
			"OPENROUTER_API_KEY",
			"E2B_API_KEY",
			"REDIS_URL",
		]) {
			expect(source).not.toMatch(new RegExp(`\\n\\s*${forbiddenSecret}\\s*=`));
		}
	});

	it("separates Runtime and consumer authority and grants standard artifact upload", () => {
		const source = terraformSource();
		const agentcoreIam = readFileSync(
			join(terraformDir, "agentcore-iam.tf"),
			"utf8",
		);

		for (const role of ["consumer", "runtime"]) {
			expect(source).toContain(`resource "aws_iam_role" "${role}"`);
		}
		expect(source).toMatch(
			/sid\s*=\s*"WriteProductionArtifacts"[\s\S]*?"s3:AbortMultipartUpload"[\s\S]*?"s3:DeleteObject"[\s\S]*?"s3:PutObject"[\s\S]*?resources\s*=\s*\["\$\{aws_s3_bucket\.artifacts\.arn\}\/objects\/\*"\]/,
		);
		expect(agentcoreIam).toContain(
			"resources = [data.aws_ecr_repository.production_runtime.arn]",
		);
		expect(source).toMatch(
			/data\s+"aws_iam_policy_document"\s+"runtime_trust"[\s\S]*?runtime\/mymemo_agentcore_prod-\*/,
		);
		expect(source).toMatch(
			/"\$\{aws_bedrockagentcore_agent_runtime\.runtime\.agent_runtime_arn\}\/runtime-endpoint\/DEFAULT"/,
		);
		expect(agentcoreIam).not.toContain('actions   = ["sqs:SendMessage"]');
		expect(source.match(/secretsmanager:VersionStage/g)).toHaveLength(2);
	});

	it("pages only on DLQ, poison, pending age, and sustained publisher errors", () => {
		const alarms = readFileSync(
			join(terraformDir, "agentcore-alarms.tf"),
			"utf8",
		);

		for (const metric of [
			"ApproximateNumberOfMessagesVisible",
			"PoisonDispatch",
			"PendingAgeMs",
			"PublisherErrors",
		]) {
			expect(alarms).toContain(`"${metric}"`);
		}
		for (const metric of [
			"ApproximateAgeOfOldestMessage",
			"DisabledDelivery",
			"PublisherLockNotAcquired",
		]) {
			expect(alarms).not.toContain(`"${metric}"`);
		}
		expect(
			alarms.match(/alarm_actions\s*=\s*var\.alarm_action_arns/g),
		).toHaveLength(4);
		expect(alarms).toMatch(
			/alarm_action_arns must contain at least one same-account, same-region SNS topic ARN/,
		);
		expect(alarms).toMatch(
			/resource\s+"aws_cloudwatch_metric_alarm"\s+"publisher_errors"[\s\S]*?evaluation_periods\s*=\s*5[\s\S]*?datapoints_to_alarm\s*=\s*3/,
		);
		expect(alarms).toMatch(
			/resource\s+"aws_cloudwatch_metric_alarm"\s+"pending_publication_age"[\s\S]*?treat_missing_data\s*=\s*"breaching"/,
		);
	});

	it("deploys the consumer and Runtime through guarded GitHub Actions", () => {
		const shellOutputDir = "$" + "{output_dir}";
		const workflow = readFileSync(
			join(root, ".github", "workflows", "release-deploy.yml"),
			"utf8",
		);
		const consumerBuild = readFileSync(
			join(root, "scripts", "deploy", "build_agentcore_consumer.sh"),
			"utf8",
		);
		const inspection = readFileSync(
			join(root, "scripts", "deploy", "inspect_agentcore.sh"),
			"utf8",
		);
		const checks = readFileSync(
			join(root, "scripts", "deploy", "agentcore_aws_checks.sh"),
			"utf8",
		);
		const mmdsv2 = readFileSync(
			join(root, "scripts", "deploy", "enforce_agentcore_mmdsv2.sh"),
			"utf8",
		);

		expect(
			existsSync(join(root, "scripts", "deploy", "deploy_agentcore.sh")),
		).toBe(false);
		expect(
			existsSync(join(root, ".github", "workflows", "agentcore-deploy.yml")),
		).toBe(false);
		expect(consumerBuild).toContain(`${shellOutputDir}/consumer.zip`);
		expect(consumerBuild).not.toContain(`${shellOutputDir}/dispatch.zip`);
		expect(workflow).toContain("workflow_dispatch:");
		expect(workflow).toContain("Run agent DB migrations");
		expect(workflow).toContain("Roll ECS services");
		expect(workflow.indexOf("Run agent DB migrations")).toBeLessThan(
			workflow.indexOf("Apply the unified release"),
		);
		expect(
			workflow.indexOf(
				"Verify AgentCore deployment and unchanged Dispatch control",
			),
		).toBeLessThan(workflow.indexOf("Roll ECS services"));
		expect(workflow).toContain("mymemo-agent-github-actions-deploy");
		expect(workflow).toContain(
			`printf 'TF_VAR_aws_region=%s\\n' "\${AWS_REGION}"`,
		);
		expect(workflow).toContain(
			`printf 'TF_VAR_aws_account_id=%s\\n' "\${AWS_ACCOUNT_ID}"`,
		);
		expect(workflow).toContain("EXPECTED_DISPATCH_VALUE");
		expect(workflow).toMatch(
			/"\$\{dispatch_value\}" != "enabled" && "\$\{dispatch_value\}" != "disabled"/,
		);
		expect(workflow).not.toContain("aws ssm put-parameter");
		expect(workflow).not.toContain("must be disabled before deployment");
		expect(workflow).toContain("agentcore-runtime-image-check.sh");
		expect(workflow).not.toContain("ecr wait image-scan-complete");
		expect(workflow).not.toContain(
			"terraform -chdir=infra/terraform output -raw runtime_image_digest",
		);
		for (const rollbackTarget of [
			"resolve_agentcore_runtime_rollback_digest",
			"ROLLBACK_RUNTIME_IMAGE_DIGEST",
			"rollbackImageDigest",
		]) {
			expect(workflow).not.toContain(rollbackTarget);
		}
		expect(workflow).toContain("build_agentcore_consumer.sh");
		expect(workflow.match(/build_agentcore_consumer\.sh/g)).toHaveLength(1);
		expect(workflow).toContain(
			"Preserve the planned AgentCore consumer package",
		);
		expect(workflow).toContain(
			"Download the planned AgentCore consumer package",
		);
		expect(workflow).toContain("actions/download-artifact@v4");
		expect(workflow.match(/oven-sh\/setup-bun@v2/g)).toHaveLength(2);
		expect(workflow).not.toContain("deployment-plan.json");
		expect(workflow).not.toContain(
			"terraform -chdir=infra/terraform show -json agent-prod.tfplan",
		);
		expect(workflow).toContain(
			"terraform -chdir=infra/terraform show -no-color agent-prod.tfplan",
		);
		expect(workflow).not.toContain("classify_terraform_plan");
		expect(workflow).toContain("terraform_prod_migration_plan.sh");
		expect(workflow).not.toContain("AGENTCORE_TERRAFORM_DIR");
		expect(workflow).toContain("enforce_agentcore_mmdsv2.sh");
		expect(workflow).toContain("inspect_agentcore.sh");
		expect(workflow).toContain("actions/upload-artifact@v4");
		for (const retired of [
			"mymemo/agentcore-canary-runtime",
			"assert_agentcore_legacy_queues_empty",
			"copy_agentcore_runtime_digest",
			"retain_legacy_runtime_repository",
		]) {
			expect(workflow).not.toContain(retired);
		}
		expect(mmdsv2).toContain("metadataConfiguration: {requireMMDSV2: true}");
		expect(mmdsv2).toContain("update-agent-runtime");
		expect(mmdsv2).toContain("get-agent-runtime-endpoint");
		expect(mmdsv2).not.toContain("requireServiceS3Endpoint");
		expect(inspection).toContain('VisibilityTimeout == "180"');
		expect(inspection).toContain("maxReceiveCount == 5");
		expect(inspection).toContain("verify_agentcore_dispatch_wiring");
		expect(inspection).toContain("expected_dispatch_value");
		expect(inspection).not.toContain("rollbackDigest");
		expect(inspection).not.toContain(
			'.Attributes.ApproximateNumberOfMessages == "0"',
		);
		expect(checks).not.toContain("events describe-rule");
		expect(checks).not.toContain("lambda get-policy");
		expect(checks).toContain("(.ReservedConcurrentExecutions // null) == null");
		expect(consumerBuild).toMatch(
			/cp "\$\{ca_bundle\}" "\$\{build_dir\}\/dispatch\/rds-global-bundle\.pem"/,
		);
	});

	it("documents roll-forward incident containment", () => {
		const runbook = readFileSync(
			join(root, "docs", "runbooks", "agentcore-rollout.md"),
			"utf8",
		);
		const rollForwardAdrPath = join(
			root,
			"docs",
			"adr",
			"0029-recover-production-releases-by-rolling-forward.md",
		);
		const rollForwardAdr = readFileSync(rollForwardAdrPath, "utf8");
		const runtimeAdr = readFileSync(
			join(
				root,
				"docs",
				"adr",
				"0025-select-the-execution-runtime-at-conversation-creation.md",
			),
			"utf8",
		);
		const publisherAdr = readFileSync(
			join(
				root,
				"docs",
				"adr",
				"0027-deploy-the-agentcore-dispatch-publisher-as-a-dedicated-service.md",
			),
			"utf8",
		);
		const rollForwardAdrLink =
			"[ADR-0029](./0029-recover-production-releases-by-rolling-forward.md)";

		expect(runbook).toContain("production releases are roll-forward only");
		expect(runbook).toContain(
			"intentionally overrides ADR-0025's preservation-oriented cutover preconditions",
		);
		expect(runbook).toContain(
			"[ADR-0029](../adr/0029-recover-production-releases-by-rolling-forward.md)",
		);
		expect(rollForwardAdr).toContain("Amends ADR-0025 and ADR-0027");
		expect(runtimeAdr).toContain(rollForwardAdrLink);
		expect(publisherAdr).toContain(rollForwardAdrLink);
		expect(runbook).toContain("## Containment and corrected release");
		expect(runbook).not.toContain("## Rollback");
		const incidentLadder = runbook.slice(
			runbook.indexOf("## Incident ladder"),
			runbook.indexOf("## Containment and corrected release"),
		);
		expect(incidentLadder).toContain(
			"[containment and corrected release](#containment-and-corrected-release)",
		);
		expect(incidentLadder).not.toContain(
			"Set `/mymemo/agentcore-dispatch/prod/enabled` to `disabled`",
		);
		expect(incidentLadder).not.toContain(
			"Keep the runtime-aware agent-worker running throughout containment",
		);
		expect(runbook.indexOf("SSM Dispatch control to `disabled`")).toBeLessThan(
			runbook.indexOf("runtime gate OFF"),
		);
		expect(runbook.indexOf("runtime gate OFF")).toBeLessThan(
			runbook.indexOf("Deploy the corrected release"),
		);
	});

	it("documents production ownership, alarm routing, and coordinated deployment", () => {
		const readme = readFileSync(join(terraformDir, "README.md"), "utf8");

		expect(readme).toContain("AgentCore Runtime");
		expect(readme).toContain("dedicated Dispatch publisher");
		expect(readme).toContain("same compatibility cycle");
		expect(readme).toContain(
			"Routine releases accept and preserve either live",
		);
	});

	it("preserves remaining state-address moves while handing off the Runtime repository", () => {
		const source = terraformSource();
		const moves = readFileSync(
			join(terraformDir, "agentcore-moved.tf"),
			"utf8",
		);

		for (const oldAddress of [
			"aws_bedrockagentcore_agent_runtime.canary",
			"aws_kms_alias.canary",
			"aws_kms_key.canary",
			"aws_security_group.canary",
			"aws_ssm_parameter.enabled",
		]) {
			expect(moves).toContain(`from = ${oldAddress}`);
		}
		expect(moves).not.toContain("aws_ecr_repository");
		expect(source).toMatch(
			/removed\s*\{[\s\S]*?from\s*=\s*aws_ecr_repository\.production_runtime[\s\S]*?destroy\s*=\s*false/,
		);
		expect(source).not.toContain("legacy_runtime");
		expect(source).not.toMatch(/resource\s+"[^"]+"\s+"canary"/);
		expect(source).not.toContain(
			`mymemo_agentcore_canary_${terraformEnvironment}`,
		);
		expect(source).not.toContain(
			`mymemo-agent-agentcore-canary-${terraformEnvironment}`,
		);
	});

	it("only protects durable resources", () => {
		const queue = readFileSync(
			join(terraformDir, "agentcore-queue.tf"),
			"utf8",
		);
		const runtime = readFileSync(
			join(terraformDir, "agentcore-runtime.tf"),
			"utf8",
		);
		const ecr = readFileSync(join(ecrTerraformDir, "main.tf"), "utf8");

		expect(queue.match(/prevent_destroy\s*=\s*true/g)).toHaveLength(4);
		expect(ecr.match(/prevent_destroy\s*=\s*true/g)).toHaveLength(1);
		expect(runtime).not.toContain("prevent_destroy");
		expect(runtime).not.toMatch(
			/resource "aws_bedrockagentcore_agent_runtime" "runtime"[\s\S]*?prevent_destroy/,
		);
	});
});

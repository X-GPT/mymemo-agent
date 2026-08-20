import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTCORE_DISPATCH_QUEUE_INVARIANTS } from "../apps/agentcore-dispatch-consumer/src/invariants";

const root = process.cwd();
const terraformDir = join(root, "infra", "agentcore");
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

	it("keeps the existing isolated state while exposing a production Terraform root", () => {
		const versions = readFileSync(join(terraformDir, "versions.tf"), "utf8");
		const readme = readFileSync(join(terraformDir, "README.md"), "utf8");

		expect(existsSync(join(root, "infra", "agentcore-canary"))).toBe(false);
		expect(versions).toContain(
			'key          = "mymemo-agent/agentcore-canary-prod.tfstate"',
		);
		expect(readme).toContain("historical");
		expect(readme).toContain("state which\nowns the production resources");
		expect(versions).toMatch(/use_lockfile\s*=\s*true/);
		expect(versions).toMatch(/encrypt\s*=\s*true/);
		expect(versions).toMatch(/version\s*=\s*">= 6\.50, < 7\.0"/);
		expect(existsSync(join(terraformDir, ".terraform.lock.hcl"))).toBe(true);
	});

	it("owns only the shared queue, consumer, Runtime, and their support resources", () => {
		const source = terraformSource();

		for (const forbiddenType of [
			"aws_ecs_cluster",
			"aws_ecs_service",
			"aws_ecs_task_definition",
			"aws_db_instance",
			"aws_elasticache_replication_group",
			"aws_s3_bucket",
			"aws_lb",
			"aws_lb_listener",
			"aws_route53_record",
		]) {
			expect(source).not.toMatch(new RegExp(`resource\\s+"${forbiddenType}"`));
		}
		expect(source).toContain('data "terraform_remote_state" "mymemo_agent"');
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
		const source = terraformSource();
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
		expect(source).not.toMatch(
			/resource\s+"aws_ecs_(service|task_definition)"/,
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
		const network = readFileSync(join(terraformDir, "network.tf"), "utf8");
		const outputs = readFileSync(join(terraformDir, "outputs.tf"), "utf8");

		expect(network).toMatch(
			/resource\s+"aws_eip"\s+"egress"[\s\S]*?for_each\s*=\s*local\.private_subnets[\s\S]*?domain\s*=\s*"vpc"/,
		);
		expect(network).toMatch(
			/resource\s+"aws_nat_gateway"\s+"egress"[\s\S]*?for_each\s*=\s*local\.private_subnets[\s\S]*?subnet_id\s*=\s*one\(local\.shared_public_subnet_ids_by_az\[each\.key\]\)/,
		);
		expect(network).toMatch(
			/resource\s+"aws_route"\s+"private_egress"[\s\S]*?for_each\s*=\s*local\.private_subnets[\s\S]*?destination_cidr_block\s*=\s*"0\.0\.0\.0\/0"[\s\S]*?nat_gateway_id\s*=\s*aws_nat_gateway\.egress\[each\.key\]\.id/,
		);
		expect(network).toContain(
			"data.terraform_remote_state.mymemo_agent.outputs.assign_public_ip",
		);
		expect(outputs).toContain('output "egress_configurations"');
	});

	it("deploys production-named Runtime resources from the agent-worker configuration", () => {
		const source = terraformSource();
		const runtime = readFileSync(join(terraformDir, "runtime.tf"), "utf8");
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
			`name_prefix = "mymemo-agent-agentcore-${terraformEnvironment}"`,
		);
		expect(runtime).toMatch(
			/resource\s+"aws_ecr_repository"\s+"production_runtime"[\s\S]*?name\s*=\s*"mymemo\/agentcore-runtime"/,
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
			/container_uri\s*=\s*"\$\{aws_ecr_repository\.production_runtime\.repository_url\}@\$\{var\.runtime_image_digest\}"/,
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
		for (const output of [
			"agent_database_url",
			"agent_database_password_secret_arn",
			"kb_database_url_secret_arn",
			"openrouter_api_key_secret_arn",
			"e2b_api_key_secret_arn",
			"redis_url_secret_arn",
			"openrouter_base_url",
			"openrouter_default_model",
			"worker_e2b_template",
			"artifact_bucket_name",
			"alarm_action_arns",
		]) {
			expect(agentOutputs).toContain(`output "${output}"`);
			expect(source).toContain(
				`data.terraform_remote_state.mymemo_agent.outputs.${output}`,
			);
		}
		for (const variable of [
			"agent_database_url_secret_arn",
			"kb_database_url_secret_arn",
			"openrouter_api_key_secret_arn",
			"e2b_api_key_secret_arn",
			"redis_url_secret_arn",
			"artifact_bucket_name",
			"openrouter_base_url",
			"openrouter_default_model",
			"worker_e2b_template",
			"alarm_action_arns",
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

		for (const role of ["consumer", "runtime"]) {
			expect(source).toContain(`resource "aws_iam_role" "${role}"`);
		}
		expect(source).toMatch(
			/sid\s*=\s*"WriteProductionArtifacts"[\s\S]*?"s3:AbortMultipartUpload"[\s\S]*?"s3:DeleteObject"[\s\S]*?"s3:PutObject"[\s\S]*?resources\s*=\s*\["arn:aws:s3:::\$\{data\.terraform_remote_state\.mymemo_agent\.outputs\.artifact_bucket_name\}\/objects\/\*"\]/,
		);
		expect(source).toMatch(
			/data\s+"aws_iam_policy_document"\s+"runtime_trust"[\s\S]*?runtime\/mymemo_agentcore_prod-\*/,
		);
		expect(source).toMatch(
			/"\$\{aws_bedrockagentcore_agent_runtime\.runtime\.agent_runtime_arn\}\/runtime-endpoint\/DEFAULT"/,
		);
		expect(source).not.toContain('actions   = ["sqs:SendMessage"]');
		expect(source.match(/secretsmanager:VersionStage/g)).toHaveLength(2);
	});

	it("pages only on DLQ, poison, pending age, and sustained publisher errors", () => {
		const alarms = readFileSync(join(terraformDir, "alarms.tf"), "utf8");

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
			alarms.match(
				/alarm_actions\s*=\s*data\.terraform_remote_state\.mymemo_agent\.outputs\.alarm_action_arns/g,
			),
		).toHaveLength(4);
		expect(alarms).toMatch(
			/agent-worker alarm_action_arns output must contain at least one same-account, same-region SNS topic ARN/,
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
			join(root, ".github", "workflows", "agentcore-deploy.yml"),
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
		expect(consumerBuild).toContain(`${shellOutputDir}/consumer.zip`);
		expect(consumerBuild).not.toContain(`${shellOutputDir}/dispatch.zip`);
		expect(workflow).toContain("workflow_dispatch:");
		expect(workflow).toContain("deploy-mymemo-agentcore-prod");
		expect(workflow).toContain("refs/heads/main");
		expect(workflow).toContain("id-token: write");
		expect(workflow).toContain("mymemo-agent-github-actions-deploy");
		expect(workflow).toMatch(/\[\[ "\$\{dispatch_value\}" != "disabled" \]\]/);
		expect(workflow).toContain("agentcore-runtime-image-check.sh");
		expect(workflow).toContain("build_agentcore_consumer.sh");
		expect(workflow).toContain("classify_agentcore_plan.sh");
		expect(workflow).toMatch(/terraform -chdir="\$\{TERRAFORM_DIR\}" apply/);
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
		expect(inspection).toContain("verify_agentcore_idle_dispatch");
		expect(checks).not.toContain("events describe-rule");
		expect(checks).not.toContain("lambda get-policy");
		expect(checks).toContain("(.ReservedConcurrentExecutions // null) == null");
		expect(consumerBuild).toMatch(
			/cp "\$\{ca_bundle\}" "\$\{build_dir\}\/dispatch\/rds-global-bundle\.pem"/,
		);
	});

	it("documents production ownership, alarm routing, and coordinated deployment", () => {
		const readme = readFileSync(join(terraformDir, "README.md"), "utf8");

		for (const section of [
			"Publisher-service boundary",
			"Runtime and consumer posture",
			"Production alarms",
			"GitHub Actions deployment",
		]) {
			expect(readme).toContain(`## ${section}`);
		}
		expect(readme).toContain("owned by `infra/terraform`");
		expect(readme).toContain("desired count one");
		expect(readme).toContain("GitHub Actions");
		expect(readme).toContain("`PendingAgeMs`");
		expect(readme).toContain("`PublisherErrors`");
		expect(readme).toContain("`PublisherLockNotAcquired`");
		expect(readme).toContain("informational telemetry");
		expect(readme).toContain("disable SSM, turn the runtime gate off");
	});

	it("preserves remaining state-address moves while removing canary resources", () => {
		const source = terraformSource();
		const moves = readFileSync(join(terraformDir, "moved.tf"), "utf8");

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
		expect(source).not.toContain("legacy_runtime");
		expect(source).not.toMatch(/resource\s+"[^"]+"\s+"canary"/);
		expect(source).not.toContain(
			`mymemo_agentcore_canary_${terraformEnvironment}`,
		);
		expect(source).not.toContain(
			`mymemo-agent-agentcore-canary-${terraformEnvironment}`,
		);
	});
});

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const terraformDir = join(root, "infra", "agentcore-canary");

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

describe("dormant AgentCore canary infrastructure", () => {
	it("uses an isolated locked state and independently pinned native AWS provider", () => {
		const versionsPath = join(terraformDir, "versions.tf");
		expect(existsSync(versionsPath)).toBe(true);
		const versions = readFileSync(versionsPath, "utf8");

		expect(versions).toContain(
			'key          = "mymemo-agent/agentcore-canary-prod.tfstate"',
		);
		expect(versions).toMatch(/use_lockfile\s*=\s*true/);
		expect(versions).toMatch(/encrypt\s*=\s*true/);
		expect(versions).toMatch(/version\s*=\s*">= 6\.50, < 7\.0"/);
		expect(versions).not.toContain("hashicorp/awscc");
		expect(existsSync(join(terraformDir, ".terraform.lock.hcl"))).toBe(true);
	});

	it("owns no shared Fargate, database, cache, bucket, or user-routing resources", () => {
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
		expect(source).not.toContain(
			'data "terraform_remote_state" "mymemo_service"',
		);
		expect(source).not.toContain("mymemo/staging.tfstate");
	});

	it("pins the encrypted standard queue, DLQ, consumer, and repair schedule contract", () => {
		const source = terraformSource();

		expect(source).toMatch(
			/resource\s+"aws_sqs_queue"\s+"dispatch"[\s\S]*?message_retention_seconds\s*=\s*86400[\s\S]*?visibility_timeout_seconds\s*=\s*300[\s\S]*?kms_master_key_id\s*=\s*aws_kms_key\.canary\.arn/,
		);
		expect(source).toMatch(
			/resource\s+"aws_sqs_queue"\s+"dead_letter"[\s\S]*?message_retention_seconds\s*=\s*86400[\s\S]*?kms_master_key_id\s*=\s*aws_kms_key\.canary\.arn/,
		);
		expect(source).toMatch(/maxReceiveCount\s*=\s*3/);
		expect(source).toMatch(
			/resource\s+"aws_lambda_function"\s+"consumer"[\s\S]*?timeout\s*=\s*120[\s\S]*?reserved_concurrent_executions\s*=\s*1/,
		);
		expect(source).toMatch(
			/resource\s+"aws_lambda_event_source_mapping"\s+"consumer"[\s\S]*?batch_size\s*=\s*1[\s\S]*?function_response_types\s*=\s*\["ReportBatchItemFailures"\][\s\S]*?enabled\s*=\s*var\.dispatch_enabled/,
		);
		expect(source).toMatch(
			/resource\s+"aws_cloudwatch_event_rule"\s+"repair"[\s\S]*?schedule_expression\s*=\s*"rate\(1 minute\)"[\s\S]*?state\s*=\s*var\.dispatch_enabled\s*\?\s*"ENABLED"\s*:\s*"DISABLED"/,
		);
		expect(source).toMatch(
			/variable\s+"dispatch_enabled"[\s\S]*?default\s*=\s*false/,
		);
	});

	it("deploys a digest-pinned native Runtime with secret-ARN-only configuration", () => {
		const source = terraformSource();

		expect(source).toContain(
			'resource "aws_bedrockagentcore_agent_runtime" "canary"',
		);
		expect(source).toMatch(
			/container_uri\s*=\s*"\$\{aws_ecr_repository\.runtime\.repository_url\}@\$\{var\.runtime_image_digest\}"/,
		);
		expect(source).toContain('image_tag_mutability = "IMMUTABLE"');
		expect(source).not.toContain('resource "aws_ecr_lifecycle_policy"');
		expect(source).toMatch(/network_mode\s*=\s*"VPC"/);
		expect(source).toMatch(/server_protocol\s*=\s*"HTTP"/);
		expect(source).toMatch(/max_lifetime\s*=\s*3600/);
		// Warning-only Terraform checks cannot enforce the deployment invariants.
		expect(source).not.toMatch(/\ncheck\s+"/);
		expect(source).toMatch(
			/resource\s+"aws_bedrockagentcore_agent_runtime"\s+"canary"[\s\S]*?precondition[\s\S]*?local\.exact_secret_arn_pattern/,
		);
		for (const name of [
			"CANARY_AGENT_DATABASE_URL_SECRET_ARN",
			"CANARY_KB_DATABASE_URL_SECRET_ARN",
			"CANARY_OPENROUTER_API_KEY_SECRET_ARN",
			"CANARY_E2B_API_KEY_SECRET_ARN",
			"CANARY_REDIS_URL_SECRET_ARN",
		]) {
			expect(source).toContain(name);
		}
		for (const forbiddenSecret of [
			"AGENT_DATABASE_URL",
			"KB_DATABASE_URL",
			"OPENROUTER_API_KEY",
			"E2B_API_KEY",
			"REDIS_URL",
		]) {
			expect(source).not.toMatch(new RegExp(`\\n\\s*${forbiddenSecret}\\s*=`));
		}
		expect(source).toMatch(
			/RDS_CA_BUNDLE_PATH\s*=\s*"\/etc\/ssl\/certs\/rds-global-bundle\.pem"/,
		);
		expect(source).toMatch(
			/NODE_EXTRA_CA_CERTS\s*=\s*"\/etc\/ssl\/certs\/rds-global-bundle\.pem"/,
		);
		const locals = readFileSync(join(terraformDir, "locals.tf"), "utf8");
		const lambdaEnvironment = locals.match(
			/lambda_common_environment\s*=\s*\{([\s\S]*?)\n\s*\}/,
		)?.[1];
		expect(lambdaEnvironment).toBeDefined();
		expect(lambdaEnvironment).not.toMatch(/\bAWS_REGION\s*=/);
	});

	it("keeps private networking while making NAT and EIP campaign-scoped", () => {
		const source = terraformSource();

		expect(source).toContain('resource "aws_subnet" "private"');
		expect(source).toMatch(/map_public_ip_on_launch\s*=\s*false/);
		expect(source).toContain('resource "aws_security_group" "canary"');
		expect(source).toMatch(
			/resource\s+"aws_eip"\s+"campaign"[\s\S]*?count\s*=\s*var\.campaign_network_enabled\s*\?\s*1\s*:\s*0/,
		);
		expect(source).toMatch(
			/resource\s+"aws_nat_gateway"\s+"campaign"[\s\S]*?count\s*=\s*var\.campaign_network_enabled\s*\?\s*1\s*:\s*0/,
		);
		expect(source).toMatch(
			/resource\s+"aws_nat_gateway"\s+"campaign"[\s\S]*?precondition[\s\S]*?outputs\.assign_public_ip/,
		);
		expect(source).toMatch(
			/variable\s+"campaign_network_enabled"[\s\S]*?default\s*=\s*false/,
		);
		expect(source).toContain('data "aws_security_group" "live_redis_clients"');
		expect(source).toContain("service_security_group_id");
		expect(source).toContain(
			"security_groups = local.runtime_security_group_ids",
		);
		expect(source).not.toMatch(/resource\s+"aws_security_group_rule"/);
	});

	it("separates least-privilege roles and restricts GitHub authority to main", () => {
		const source = terraformSource();
		const workflow = readFileSync(
			join(root, ".github", "workflows", "agentcore-canary-deploy.yml"),
			"utf8",
		);
		const bootstrapScript = readFileSync(
			join(root, "scripts", "deploy", "bootstrap_agentcore_canary.sh"),
			"utf8",
		);
		const artifactPublication = readFileSync(
			join(
				root,
				"apps",
				"agent-worker",
				"src",
				"artifacts",
				"artifact-publication.ts",
			),
			"utf8",
		);
		const planClassifier = readFileSync(
			join(root, "scripts", "deploy", "classify_agentcore_canary_plan.ts"),
			"utf8",
		);

		for (const role of [
			"deployment",
			"campaign_launch",
			"task",
			"publisher",
			"consumer",
			"runtime",
			"fault_injection",
			"preflight",
		]) {
			expect(source).toContain(`resource "aws_iam_role" "${role}"`);
		}
		expect(source).toMatch(
			/repo:\$\{var\.github_owner\}\/\$\{var\.github_repository\}:ref:refs\/heads\/main/,
		);
		expect(source).not.toContain(":environment:");
		expect(source).toContain(
			'data "aws_iam_policy_document" "github_main_trust"',
		);
		expect(source.match(/github_main_trust\.json/g)).toHaveLength(2);
		expect(source).toMatch(
			/"\$\{aws_bedrockagentcore_agent_runtime\.canary\.agent_runtime_arn\}\/runtime-endpoint\/DEFAULT"/,
		);
		expect(source).toMatch(
			/output\s+"runtime_security_configuration"[\s\S]*?role_arn\s*=\s*aws_iam_role\.runtime\.arn[\s\S]*?environment_variables\s*=\s*local\.runtime_environment[\s\S]*?subnet_ids\s*=\s*sort\(values\(aws_subnet\.private\)\[\*\]\.id\)[\s\S]*?security_group_ids\s*=\s*sort\(local\.runtime_security_group_ids\)[\s\S]*?idle_runtime_session_timeout\s*=\s*900/,
		);
		expect(source).toMatch(/resources\s*=\s*local\.exact_secret_arns/);
		expect(source).toMatch(
			/sid\s*=\s*"WriteSyntheticArtifactsOnly"[\s\S]*?actions\s*=\s*\["s3:AbortMultipartUpload", "s3:PutObject"\]/,
		);
		expect(source).toMatch(
			/sid\s*=\s*"WriteSyntheticArtifactsOnly"[\s\S]*?resources\s*=\s*\["arn:aws:s3:::\$\{var\.artifact_bucket_name\}\/objects\/\*"\]/,
		);
		expect(artifactPublication).toMatch(
			/deps\.createObjectKey\s*\?\?\s*\(\(\)\s*=>\s*`objects\/\$\{crypto\.randomUUID\(\)\}`\)/,
		);
		expect(source).toMatch(
			/sid\s*=\s*"CreateCanaryEventMappingOnly"[\s\S]*?actions\s*=\s*\["lambda:CreateEventSourceMapping"\][\s\S]*?resources\s*=\s*\["\*"\][\s\S]*?lambda:FunctionArn[\s\S]*?-consumer/,
		);
		expect(source).toMatch(
			/sid\s*=\s*"UpdateCanaryEventMappingOnly"[\s\S]*?actions\s*=\s*\["lambda:UpdateEventSourceMapping"\][\s\S]*?event-source-mapping:\*[\s\S]*?lambda:FunctionArn[\s\S]*?-consumer/,
		);
		expect(planClassifier).toMatch(
			/CreateCanaryEventMappingOnly:[\s\S]*?actions:\s*\["lambda:CreateEventSourceMapping"\][\s\S]*?resourcePatterns:\s*\["\*"\][\s\S]*?lambda:FunctionArn[\s\S]*?-consumer/,
		);
		expect(planClassifier).toMatch(
			/UpdateCanaryEventMappingOnly:[\s\S]*?actions:\s*\["lambda:UpdateEventSourceMapping"\][\s\S]*?event-source-mapping:\*[\s\S]*?lambda:FunctionArn[\s\S]*?-consumer/,
		);
		expect(source).not.toMatch(
			/resource\s+"aws_iam_role_policy"\s+"campaign_launch"[\s\S]*?(rds:|secretsmanager:GetSecretValue)/,
		);
		expect(source).not.toContain("iam:UpdateAssumeRolePolicy");
		expect(source).toMatch(
			/sid\s*=\s*"DedicatedTerraformState"[\s\S]*?actions\s*=\s*\["s3:GetObject", "s3:PutObject"\][\s\S]*?agentcore-canary-prod\.tfstate"/,
		);
		expect(source).toMatch(
			/sid\s*=\s*"DedicatedTerraformLock"[\s\S]*?"s3:DeleteObject"[\s\S]*?agentcore-canary-prod\.tfstate\.tflock"/,
		);
		expect(source).not.toContain("agentcore-canary-prod.tfstate*");
		expect(source.match(/secretsmanager:VersionStage/g)).toHaveLength(4);
		expect(source).toMatch(
			/data\s+"aws_iam_policy_document"\s+"states_trust"[\s\S]*?variable\s*=\s*"aws:SourceArn"[\s\S]*?stateMachine:\$\{local\.name_prefix\}-\*/,
		);
		expect(source).toMatch(
			/data\s+"aws_iam_policy_document"\s+"runtime_trust"[\s\S]*?runtime\/mymemo_agentcore_canary_prod-\*/,
		);
		for (const action of [
			"ec2:AssignPrivateIpAddresses",
			"ec2:CreateNetworkInterface",
			"ec2:DeleteNetworkInterface",
			"ec2:DescribeNetworkInterfaces",
			"ec2:DescribeSubnets",
			"ec2:UnassignPrivateIpAddresses",
		]) {
			expect(source.match(new RegExp(action, "g"))).toHaveLength(2);
		}
		const managedRoles = source.match(
			/sid\s*=\s*"ManageCanaryRolesOnly"([\s\S]*?)\n\s*}/,
		)?.[1];
		expect(managedRoles).not.toContain("-deployment");
		expect(managedRoles).not.toContain("-campaign-launch");
		expect(bootstrapScript).toContain("-target=aws_iam_role.campaign_launch");
		expect(bootstrapScript).toContain(
			"-target=aws_iam_role_policy.campaign_launch",
		);
		expect(bootstrapScript).toContain(
			"-target=aws_cloudwatch_event_rule.repair",
		);
		expect(bootstrapScript).toContain(
			"classify_agentcore_canary_plan.sh agentcore-canary-bootstrap.tfplan",
		);
		expect(bootstrapScript).toContain(
			"terraform -chdir=infra/agentcore-canary apply",
		);
		expect(bootstrapScript).toContain('aws_profile="mymemo"');
		expect(bootstrapScript).not.toContain("AWS_PROFILE:-");
		expect(bootstrapScript).toContain("git rev-parse origin/main");
		expect(workflow).toMatch(
			/previous_runtime_image_digest[\s\S]*?sha256:0{64}[\s\S]*?previous_runtime_image_digest=""/,
		);
		expect(workflow).not.toContain("verify_github_canary_environment.sh");
		expect(bootstrapScript).not.toContain(
			"verify_github_canary_environment.sh",
		);
		expect(bootstrapScript).toMatch(
			/gh variable get "\$1" --repo "\$\{repository\}"/,
		);
		expect(bootstrapScript).not.toContain("--env");
		expect(
			existsSync(
				join(root, "scripts", "deploy", "verify_github_canary_environment.sh"),
			),
		).toBe(false);
		expect(workflow).not.toContain("bootstrap_canary_authority");
		expect(workflow).not.toContain("agentcore-canary-bootstrap");
		const bootstrapIam = readFileSync(
			join(root, "infra", "bootstrap-iam", "main.tf"),
			"utf8",
		);
		expect(bootstrapIam).not.toContain("agentcore_canary_bootstrap");
		expect(bootstrapIam).not.toContain("agentcore-canary-bootstrap");
		expect(source).toMatch(
			/resource\s+"aws_lambda_function"\s+"preflight"[\s\S]*?role\s*=\s*aws_iam_role\.preflight\.arn/,
		);
		const lambdas = readFileSync(join(terraformDir, "lambdas.tf"), "utf8");
		for (const policy of [
			"publisher",
			"publisher_base",
			"consumer",
			"consumer_base",
			"control",
			"control_base",
			"preflight",
		]) {
			expect(lambdas).toContain(`aws_iam_role_policy.${policy}`);
		}
		expect(source).toMatch(
			/data\s+"aws_iam_policy_document"\s+"preflight"[\s\S]*?resources\s*=\s*\[var\.agent_database_url_secret_arn, var\.kb_database_url_secret_arn\]/,
		);
		expect(source).not.toContain('sid = "InvokeConnectivityPreflightOnly"');
		expect(source).toMatch(
			/sid\s*=\s*"ReadCanaryRepositoryOnly"[\s\S]*?resources\s*=\s*\["arn:aws:ecr:\$\{var\.aws_region\}:\$\{var\.aws_account_id\}:repository\/mymemo\/agentcore-canary-runtime"\]/,
		);
		expect(source).toMatch(
			/sid\s*=\s*"ReadCanaryEnablementOnly"[\s\S]*?resources\s*=\s*\["arn:aws:ssm:\$\{var\.aws_region\}:\$\{var\.aws_account_id\}:parameter\/mymemo\/agentcore-canary\/\$\{var\.environment\}\/enabled"\]/,
		);
		const broadRead = source.match(
			/sid\s*=\s*"ReadCanaryControlPlane"([\s\S]*?)\n\s*}/,
		)?.[1];
		expect(broadRead).not.toContain("ecr:BatchGetImage");
		expect(broadRead).not.toContain("ecr:GetDownloadUrlForLayer");
		expect(broadRead).not.toContain("ssm:GetParameter");
		expect(source).toMatch(
			/data\s+"aws_iam_policy_document"\s+"task"[\s\S]*?aws_lambda_function\.preflight\.arn/,
		);
		expect(source).toMatch(
			/resource\s+"aws_lambda_event_source_mapping"\s+"consumer"[\s\S]*?precondition[\s\S]*?!var\.dispatch_enabled\s*\|\|\s*var\.campaign_network_enabled/,
		);
		expect(source).toMatch(
			/sid\s*=\s*"TagCanaryNetworkOnCreate"[\s\S]*?variable\s*=\s*"ec2:CreateAction"/,
		);
		expect(source).toMatch(
			/sid\s*=\s*"ManageCanaryRepairTargetOnly"[\s\S]*?variable\s*=\s*"events:TargetArn"[\s\S]*?-publisher/,
		);
		expect(source).toMatch(
			/sid\s*=\s*"ManageCanaryRepairPermissionOnly"[\s\S]*?variable\s*=\s*"lambda:Principal"[\s\S]*?events\.amazonaws\.com/,
		);
		expect(source).toContain('variable = "iam:AssociatedResourceArn"');
		expect(source).not.toContain('"events:EnableRule"');
		expect(source).not.toContain('"events:PutRule"');
	});

	it("keeps the publisher cold-start contract free of consumer-only Runtime authority", () => {
		const lambdas = readFileSync(join(terraformDir, "lambdas.tf"), "utf8");
		const publisher = lambdas.match(
			/resource\s+"aws_lambda_function"\s+"publisher"([\s\S]*?)resource\s+"aws_lambda_function"\s+"consumer"/,
		)?.[1];
		const consumer = lambdas.match(
			/resource\s+"aws_lambda_function"\s+"consumer"([\s\S]*?)resource\s+"aws_lambda_function"\s+"control"/,
		)?.[1];
		const production = readFileSync(
			join(root, "apps", "agentcore-canary-dispatch", "src", "production.ts"),
			"utf8",
		);

		expect(publisher).not.toContain("CANARY_AGENT_RUNTIME_ARN");
		expect(consumer).toContain("CANARY_AGENT_RUNTIME_ARN");
		expect(production).toMatch(
			/const publisher = createRetryableAsyncSingleton[\s\S]*?resolveCanaryDispatchPublisherConfigFromSecretArns/,
		);
		expect(production).toMatch(
			/export async function publisherHandler[\s\S]*?publish: await publisher\(\)/,
		);
	});

	it("creates low-cardinality paging and validation alarms", () => {
		const alarms = readFileSync(join(terraformDir, "alarms.tf"), "utf8");

		for (const metric of [
			"ApproximateAgeOfOldestMessage",
			"ApproximateNumberOfMessagesVisible",
			"Errors",
			"Throttles",
			"ActiveSessionCount",
		]) {
			expect(alarms).toMatch(new RegExp(`metric_name\\s*=\\s*"${metric}"`));
		}
		for (const metric of [
			"PoisonDispatch",
			"CrossLaneExecution",
			"CleanupResidue",
			"CampaignDeadlineBreach",
			"NatExpiryBreach",
		]) {
			expect(alarms).toContain(`"${metric}"`);
		}
		expect(alarms).toMatch(/metric_name\s*=\s*each\.value/);
		expect(alarms).toContain("account-level AgentCore Runtime session");
		for (const forbiddenDimension of [
			"CampaignId",
			"ConversationId",
			"RunId",
			"Prompt",
			"Model",
			"Tool",
			"DocumentId",
			"Artifact",
		]) {
			expect(alarms).not.toContain(forbiddenDimension);
		}
		expect(alarms).toMatch(
			/alarm_actions\s*=\s*var\.incident_alarm_action_arns/,
		);
		expect(alarms).toMatch(
			/alarm_actions\s*=\s*var\.validation_alarm_action_arns/,
		);
	});

	it("ships a manual main-bound image promotion and dormant inspection", () => {
		const workflow = readFileSync(
			join(root, ".github", "workflows", "agentcore-canary-deploy.yml"),
			"utf8",
		);
		const inspection = readFileSync(
			join(root, "scripts", "deploy", "inspect_agentcore_canary_dormant.sh"),
			"utf8",
		);
		const sharedChecks = readFileSync(
			join(root, "scripts", "deploy", "agentcore_canary_aws_checks.sh"),
			"utf8",
		);
		const inspectionChecks = `${inspection}\n${sharedChecks}`;

		expect(workflow).toContain("workflow_dispatch:");
		expect(workflow).not.toMatch(/\n\s+(push|workflow_run):/);
		expect(workflow).not.toMatch(/\n\s+environment:/);
		expect(workflow).toContain("deploy-mymemo-agentcore-canary-prod");
		expect(
			workflow.match(/name: Confirm manual production intent/g),
		).toHaveLength(1);
		expect(workflow).not.toContain("verify_github_canary_environment.sh");
		expect(workflow).toContain("RDS_CA_BUNDLE_SHA256:");
		expect(
			workflow.match(
				/e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3/g,
			),
		).toHaveLength(1);
		expect(workflow).toContain("platforms: linux/arm64");
		expect(workflow).toContain("docker pull --platform linux/arm64");
		expect(workflow).toContain(
			"agentcore-canary-runtime-image-check.sh agentcore-canary-existing:verified",
		);
		expect(workflow).toContain("runtime_image_digest");
		expect(workflow).toContain("classify_agentcore_canary_plan.sh");
		expect(workflow).toContain("requireMMDSV2");
		expect(workflow).toContain("inspect_agentcore_canary_dormant.sh");
		expect(workflow).toContain("record the live version");
		expect(workflow).not.toContain(
			"terraform -chdir=infra/agentcore-canary output -raw agent_runtime_version",
		);

		for (const requiredCheck of [
			"get-queue-attributes",
			"get-event-source-mapping",
			"describe-rule",
			"get-parameter",
			"get-agent-runtime",
			"get-agent-runtime-endpoint",
			"metadataConfiguration.requireMMDSV2",
			"ActiveSessionCount",
			"campaign_nat_gateway_ids",
			"campaign_eip_allocation_ids",
		]) {
			expect(inspectionChecks).toContain(requiredCheck);
		}
		expect(inspection).toContain("verify_agentcore_canary_disabled_dispatch");
		expect(inspection).toContain(
			"verify_agentcore_canary_runtime_configuration",
		);
		expect(inspection).toContain(
			"verify_agentcore_canary_consumer_runtime_authority",
		);
		expect(inspection).toMatch(
			/verify_agentcore_canary_current_secrets "\$\{region\}" "\$\{tf_output\}"/,
		);
		expect(inspection).toMatch(
			/verify_agentcore_canary_alarms "\$\{region\}" "\$\{tf_output\}"/,
		);
		expect(sharedChecks).toContain("list-secret-version-ids");
		expect(sharedChecks).toContain("describe-alarms");
		expect(sharedChecks).toContain("--profile mymemo");
		expect(inspection).toContain('aws_profile="mymemo"');
		expect(inspection).not.toContain("AWS_PROFILE:-");
		expect(inspection).toContain(
			'(.Attributes.FifoQueue // "false") == "false"',
		);
		expect(
			inspection.match(/ApproximateNumberOfMessagesDelayed/g),
		).toHaveLength(2);
		expect(inspection).not.toContain("!= *.fifo");
		expect(inspection).toContain("describe-nat-gateways");
		expect(inspection).toContain("describe-addresses");
		expect(inspection).toContain(
			'activeRuntimeSessionsScope:"account-region-service"',
		);
		expect(inspection).not.toContain("invoke-function");
		expect(inspection).not.toContain("invoke-agent-runtime");
	});

	it("ships a non-Run verified-TLS preflight with rollback and cleanup checks", () => {
		const preflight = readFileSync(
			join(root, "scripts", "deploy", "preflight_agentcore_canary.sh"),
			"utf8",
		);
		const sharedChecks = readFileSync(
			join(root, "scripts", "deploy", "agentcore_canary_aws_checks.sh"),
			"utf8",
		);

		expect(terraformSource()).toContain(
			'resource "aws_lambda_function" "preflight"',
		);
		expect(preflight).toContain("preflight_function_name");
		expect(preflight).toContain(".runtime_image_digest.value");
		expect(preflight).toContain("lambda invoke");
		expect(preflight).toContain("runAdmitted == false");
		expect(preflight).toContain("describe-images");
		expect(preflight).toContain("StopRuntimeSession");
		expect(preflight).toContain("verify_agentcore_canary_alarms");
		expect(preflight).toContain("verify_agentcore_canary_current_secrets");
		expect(preflight).toContain("verify_agentcore_canary_disabled_dispatch");
		expect(preflight).toContain(
			"verify_agentcore_canary_runtime_configuration",
		);
		expect(preflight).toContain(
			"verify_agentcore_canary_consumer_runtime_authority",
		);
		expect(preflight).toContain("configurationVerified:true");
		expect(preflight).toContain("dispatchEnabled:false");
		expect(sharedChecks).toContain("describe-alarms");
		for (const liveCheck of [
			"get-event-source-mapping",
			"describe-rule",
			"get-parameter",
			"get-agent-runtime",
			"get-agent-runtime-endpoint",
			"metadataConfiguration.requireMMDSV2",
			"simulate-principal-policy",
			"runtime_security_configuration.value",
			".roleArn == $expected.role_arn",
			".environmentVariables == $expected.environment_variables",
			"networkModeConfig.subnets | sort",
			"networkModeConfig.securityGroups | sort",
			"idleRuntimeSessionTimeout == $expected.idle_runtime_session_timeout",
		]) {
			expect(sharedChecks).toContain(liveCheck);
		}
		expect(preflight).toContain("ApproximateNumberOfMessagesDelayed");
		expect(preflight).toContain('aws_profile="mymemo"');
		expect(preflight).not.toContain("AWS_PROFILE:-");
		expect(preflight).not.toContain("invoke-agent-runtime");
		expect(preflight).not.toContain("/runs");
		const readme = readFileSync(join(terraformDir, "README.md"), "utf8");
		expect(readme).toContain("Issue #453 owns the temporary network window");
		expect(readme).toMatch(
			/That workflow is deleted\s+after the campaign, leaving no normal-production control-path trigger\./,
		);
	});

	it("packages the pinned RDS trust bundle for every database Lambda", () => {
		const source = terraformSource();
		const build = readFileSync(
			join(root, "scripts", "deploy", "build_agentcore_canary_lambdas.sh"),
			"utf8",
		);

		expect(source).toMatch(
			/RDS_CA_BUNDLE_PATH\s*=\s*"\/var\/task\/rds-global-bundle\.pem"/,
		);
		expect(source).toMatch(
			/NODE_EXTRA_CA_CERTS\s*=\s*"\/var\/task\/rds-global-bundle\.pem"/,
		);
		expect(build).toMatch(
			/cp "\$\{ca_bundle\}" "\$\{build_dir\}\/dispatch\/rds-global-bundle\.pem"/,
		);
		expect(build).toMatch(
			/cp "\$\{ca_bundle\}" "\$\{build_dir\}\/control\/rds-global-bundle\.pem"/,
		);
	});

	it("leaves canary enablement under explicit operator control", () => {
		const queue = readFileSync(join(terraformDir, "queue.tf"), "utf8");
		expect(queue).toMatch(
			/resource\s+"aws_ssm_parameter"\s+"enabled"[\s\S]*?ignore_changes\s*=\s*\[value\]/,
		);
	});
});

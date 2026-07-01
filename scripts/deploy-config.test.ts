import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadWorkerConfigFromEnv } from "../apps/agent-worker/src/config/env";
import { loadApiConfigFromEnv } from "../apps/chat-api/src/config/env";

const root = process.cwd();
const terraformDir = join(root, "infra", "terraform");
const ecrTerraformDir = join(root, "infra", "ecr");
const bootstrapIamTerraformDir = join(root, "infra", "bootstrap-iam");
const exampleTfvars = readFileSync(
	join(terraformDir, "examples", "prod.tfvars.example"),
	"utf8",
);
const prodDeployEnv = readFileSync(join(root, "infra", "deploy", "prod.env"), "utf8");
const prodTfvars = readFileSync(join(terraformDir, "prod.tfvars"), "utf8");
const prodSecretsExample = readFileSync(
	join(root, "infra", "deploy", "prod.secrets.env.example"),
	"utf8",
);
const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
const releaseDeployWorkflow = readFileSync(
	join(root, ".github", "workflows", "release-deploy.yml"),
	"utf8",
);
const createAgentSecretsScript = readFileSync(
	join(root, "scripts", "deploy", "create_agent_secrets.sh"),
	"utf8",
);

function terraformFiles(dir = terraformDir): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return terraformFiles(path);
		return entry.name.endsWith(".tf") ? [path] : [];
	});
}

describe("agent deployment config", () => {
	it("does not define a new VPC in mymemo-agent Terraform", () => {
		const combined = terraformFiles()
			.map((path) => readFileSync(path, "utf8"))
			.join("\n");

		expect(combined).not.toMatch(/resource\s+"aws_vpc"/);
		expect(combined).not.toMatch(/resource\s+"aws_subnet"/);
		expect(combined).toContain('data "terraform_remote_state" "mymemo_service"');
		expect(combined).toContain("shared_ecs_subnet_ids");
	});

	it("example tfvars include required deploy inputs and optional secret-name overrides", () => {
		for (const required of [
			"assign_public_ip",
			"agent_db_instance_class",
			"kb_database_url_secret_name",
			"llm_token_secret_name",
			"statsig_server_secret_name",
			"openrouter_api_key_secret_name",
			"e2b_api_key_secret_name",
		]) {
			expect(exampleTfvars).toContain(required);
		}
	});

	it("agent deploy config does not duplicate shared mymemo-service IDs", () => {
		for (const forbidden of [
			"VPC_ID=",
			"PRIVATE_SUBNET_IDS=",
			"ECS_CLUSTER_ARN=",
			"ALB_LISTENER_ARN=",
			"ALB_SECURITY_GROUP_ID=",
			"vpc-05772c7f2f628c024",
			"sg-0871613142f607a90",
			"mymemo-staging-cluster",
			"mymemo-staging-alb/acf2230a5f2f6afb/136a14cb4f1792d9",
		]) {
			expect(prodDeployEnv).not.toContain(forbidden);
		}
	});

	it("example tfvars do not contain literal secret values", () => {
		expect(exampleTfvars).not.toMatch(/sk-(ant|or)-[A-Za-z0-9]/);
		expect(exampleTfvars).not.toMatch(/postgres(?:ql)?:\/\/[^"\s]+:[^"@\s]+@/);
		expect(exampleTfvars).not.toMatch(/LLM_TOKEN_SECRET\s*=/);
		expect(exampleTfvars).not.toMatch(/OPENROUTER_API_KEY\s*=/);
		expect(exampleTfvars).not.toMatch(/E2B_API_KEY\s*=/);
		expect(exampleTfvars).not.toMatch(/STATSIG_SERVER_SECRET\s*=/);
	});

	it("checked-in prod tfvars owns repeatable Terraform inputs", () => {
		for (const required of [
			'aws_region  = "us-west-2"',
			'environment = "prod"',
			"assign_public_ip = true",
			'gateway_public_url         = "REPLACE_ME_AGENT_GATEWAY_PUBLIC_URL"',
			'openrouter_default_model   = "anthropic/claude-sonnet-4"',
		]) {
			expect(prodTfvars).toContain(required);
		}
		expect(prodTfvars).toContain("mymemo-agent-prod-KB_DATABASE_URL");
		expect(prodTfvars).not.toContain("CREATE_AGENT_DATABASE");
		expect(prodTfvars).not.toContain("AGENT_DATABASE_URL_SECRET_ARN");
		expect(prodTfvars).not.toContain("DB_PASSWORD_SECRET_ARN");
		expect(prodTfvars).not.toContain("_SECRET_ARN");
	});

	it("checked-in prod deploy env is limited to CI and smoke inputs", () => {
		for (const required of [
			"AWS_REGION=us-west-2",
			"AWS_ACCOUNT_ID=637423444544",
			"DEPLOY_ENVIRONMENT=prod",
			"AGENT_SMOKE_BASE_URL=REPLACE_ME_AGENT_SMOKE_BASE_URL",
		]) {
			expect(prodDeployEnv).toContain(required);
		}
		for (const terraformOnly of [
			"ASSIGN_PUBLIC_IP=",
			"GATEWAY_PUBLIC_URL=",
			"OPENROUTER_DEFAULT_MODEL=",
			"AGENT_DB_INSTANCE_CLASS=",
			"CHAT_API_DESIRED_COUNT=",
		]) {
			expect(prodDeployEnv).not.toContain(terraformOnly);
		}
	});

	it("release deploy uses normal ECR terraform apply and not target apply", () => {
		const ecrCombined = terraformFiles(ecrTerraformDir)
			.map((path) => readFileSync(path, "utf8"))
			.join("\n");

		expect(ecrCombined).toContain('resource "aws_ecr_repository" "chat_api"');
		expect(releaseDeployWorkflow).toContain("terraform -chdir=infra/ecr apply -auto-approve");
		expect(releaseDeployWorkflow).not.toContain("-target=");
		expect(releaseDeployWorkflow).not.toContain("bootstrap_ecr_repositories.sh");
	});

	it("release deploy does not rewrite long-lived application secrets", () => {
		expect(releaseDeployWorkflow).not.toContain("create_agent_secrets.sh");
		expect(releaseDeployWorkflow).not.toContain("LLM_TOKEN_SECRET_VALUE");
		expect(releaseDeployWorkflow).not.toContain("OPENROUTER_API_KEY_VALUE");
	});

	it("checked-in prod deploy env contains no literal secret values", () => {
		expect(prodDeployEnv).not.toContain("arn:aws:secretsmanager");
		expect(prodTfvars).not.toContain("arn:aws:secretsmanager");
		expect(prodDeployEnv).not.toMatch(/sk-(ant|or)-[A-Za-z0-9]/);
		expect(prodTfvars).not.toMatch(/sk-(ant|or)-[A-Za-z0-9]/);
		expect(prodDeployEnv).not.toMatch(/postgres(?:ql)?:\/\/[^"\s]+:[^"@\s]+@/);
		expect(prodTfvars).not.toMatch(/postgres(?:ql)?:\/\/[^"\s]+:[^"@\s]+@/);
		expect(prodDeployEnv).not.toMatch(/^LLM_TOKEN_SECRET=/m);
		expect(prodDeployEnv).not.toMatch(/^OPENROUTER_API_KEY=/m);
		expect(prodDeployEnv).not.toMatch(/^E2B_API_KEY=/m);
		expect(prodDeployEnv).not.toMatch(/^STATSIG_SERVER_SECRET=/m);
	});

	it("local secret bootstrap files are ignored and examples are empty", () => {
		expect(gitignore).toContain("infra/deploy/*.secrets.env");
		expect(gitignore).toContain("infra/terraform/generated.auto.tfvars");
		expect(prodSecretsExample).toContain("LLM_TOKEN_SECRET_VALUE=");
		expect(prodSecretsExample).toContain("OPENROUTER_API_KEY_VALUE=");
		expect(prodSecretsExample).not.toMatch(/=. +/);
		expect(prodSecretsExample).not.toMatch(/sk-(ant|or)-[A-Za-z0-9]/);
		expect(prodSecretsExample).not.toMatch(/postgres(?:ql)?:\/\/[^"\s]+:[^"@\s]+@/);
	});

	it("release deploy runs migrations before rolling ECS services", () => {
		const migrationIndex = releaseDeployWorkflow.indexOf(
			"scripts/deploy/run_agent_migration.sh",
		);
		const rolloutIndex = releaseDeployWorkflow.indexOf(
			"scripts/deploy/roll_ecs_services.sh",
		);

		expect(migrationIndex).toBeGreaterThan(-1);
		expect(rolloutIndex).toBeGreaterThan(-1);
		expect(migrationIndex).toBeLessThan(rolloutIndex);
	});

	it("terraform does not roll ECS services before migrations", () => {
		const ecsConfig = readFileSync(join(terraformDir, "ecs.tf"), "utf8");
		const outputs = readFileSync(join(terraformDir, "outputs.tf"), "utf8");
		const rolloutScript = readFileSync(
			join(root, "scripts", "deploy", "roll_ecs_services.sh"),
			"utf8",
		);

		expect(ecsConfig).toContain("ignore_changes = [task_definition]");
		expect(outputs).toContain('output "chat_api_task_definition_arn"');
		expect(outputs).toContain('output "agent_worker_task_definition_arn"');
		expect(rolloutScript).toContain("terraform -chdir=infra/terraform output -raw chat_api_task_definition_arn");
		expect(rolloutScript).toContain("terraform -chdir=infra/terraform output -raw agent_worker_task_definition_arn");
		expect(rolloutScript).toContain('--task-definition "$chat_api_task_definition"');
		expect(rolloutScript).toContain('--task-definition "$agent_worker_task_definition"');
	});

	it("release deploy plans with checked-in Terraform tfvars plus generated image overlay", () => {
		const planScript = readFileSync(
			join(root, "scripts", "deploy", "terraform_prod_in_place_plan.sh"),
			"utf8",
		);
		const prepareScript = readFileSync(
			join(root, "scripts", "deploy", "ci_prepare_tfvars.sh"),
			"utf8",
		);

		expect(planScript).toContain('tfvars_file="${TFVARS_FILE:-infra/terraform/prod.tfvars}"');
		expect(planScript).toContain('generated_tfvars_file_abs=');
		expect(planScript).toContain('terraform -chdir=infra/terraform plan -var-file="$tfvars_file_abs" -var-file="$generated_tfvars_file_abs"');
		expect(planScript).toContain("generated.auto.tfvars");
		expect(prepareScript).toContain("chat_api_image");
		expect(prepareScript).not.toContain("gateway_public_url");
		expect(prepareScript).not.toContain("agent_db_instance_class");
		expect(prepareScript).not.toContain("DEPLOY_CONFIG");
		expect(prepareScript).not.toContain("prod.env");
		expect(releaseDeployWorkflow).toContain('AWS_ACCOUNT_ID: "637423444544"');
		expect(releaseDeployWorkflow).toContain(
			"arn:aws:iam::${{ env.AWS_ACCOUNT_ID }}:role/mymemo-agent-github-actions-deploy",
		);
		expect(releaseDeployWorkflow).toContain("DEPLOY_ENVIRONMENT: ${{ inputs.environment }}");
		expect(releaseDeployWorkflow).toContain("GITHUB_RUN_ATTEMPT");
	});

	it("bootstrap IAM owns the agent-specific GitHub Actions deploy role", () => {
		const combined = terraformFiles(bootstrapIamTerraformDir)
			.map((path) => readFileSync(path, "utf8"))
			.join("\n");

		expect(combined).toContain('default     = "mymemo-agent-github-actions-deploy"');
		expect(combined).toContain("token.actions.githubusercontent.com:sub");
		expect(combined).toContain("repo:${var.github_owner}/${var.github_repository}:environment:${var.github_environment}");
		expect(combined).toContain("sts:AssumeRoleWithWebIdentity");
		expect(combined).toContain("mymemo-agent/bootstrap-iam-prod.tfstate");
		expect(combined).not.toContain("mymemo-github-actions-deploy");
	});

	it("release deploy serializes runs and validates image tags before exporting env", () => {
		expect(releaseDeployWorkflow).toContain("concurrency:");
		expect(releaseDeployWorkflow).toContain("group: release-deploy-${{ inputs.environment }}");
		expect(releaseDeployWorkflow).toContain("cancel-in-progress: false");
		expect(releaseDeployWorkflow).toContain('if [[ ! "${image_tag}" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]');
		expect(releaseDeployWorkflow).toContain("printf 'IMAGE_TAG=%s\\n'");
		expect(releaseDeployWorkflow).not.toContain('echo "IMAGE_TAG=${REQUESTED_IMAGE_TAG}" >> "${GITHUB_ENV}"');
	});

	it("shared infrastructure fallbacks are explicit and conditional", () => {
		const locals = readFileSync(join(terraformDir, "locals.tf"), "utf8");
		const sharedState = readFileSync(join(terraformDir, "shared_state.tf"), "utf8");
		const cloudwatch = readFileSync(join(terraformDir, "cloudwatch.tf"), "utf8");

		expect(locals).toContain("shared_vpc_id         = local.shared_service_outputs.vpc_id");
		expect(sharedState).not.toContain('data "aws_subnet" "shared_ecs_first"');
		expect(sharedState).toContain('data "aws_ecs_cluster" "shared"');
		expect(sharedState).toContain("count = local.shared_ecs_cluster_arn_output == null");
		expect(sharedState).toContain('data "aws_lb" "shared"');
		expect(sharedState).toContain("count = local.shared_alb_arn_output != null");
		expect(sharedState).toContain('data "aws_lb_listener" "shared_https"');
		expect(sharedState).toContain("count = local.shared_alb_listener_arn_output == null");
		expect(cloudwatch).toContain("ClusterName = local.shared_ecs_cluster_name");
		expect(cloudwatch).not.toContain("outputs.ecs_cluster_name");
	});

	it("migration task uses Terraform network settings", () => {
		const migrationScript = readFileSync(
			join(root, "scripts", "deploy", "run_agent_migration.sh"),
			"utf8",
		);
		const outputs = readFileSync(join(terraformDir, "outputs.tf"), "utf8");

		expect(outputs).toContain('output "assign_public_ip"');
		expect(migrationScript).toContain("terraform -chdir=infra/terraform output -raw assign_public_ip");
		expect(migrationScript).not.toContain("ASSIGN_PUBLIC_IP");
	});

	it("ecs desired counts remain Terraform-managed", () => {
		const ecsConfig = readFileSync(join(terraformDir, "ecs.tf"), "utf8");

		expect(ecsConfig).toContain("desired_count   = var.chat_api_desired_count");
		expect(ecsConfig).toContain("desired_count   = var.agent_worker_desired_count");
		expect(ecsConfig).not.toContain("ignore_changes = [desired_count]");
	});

	it("deploy scripts share config loading", () => {
		const loader = readFileSync(
			join(root, "scripts", "deploy", "lib", "load_config.sh"),
			"utf8",
		);

		expect(loader).toContain("load_deploy_config()");
		expect(loader).toContain("DEPLOY_CONFIG_PATH=");
		for (const script of [
			"build_and_push_agent_image.sh",
			"create_agent_secrets.sh",
			"prod_smoke.sh",
			"roll_ecs_services.sh",
			"run_agent_migration.sh",
		]) {
			const content = readFileSync(join(root, "scripts", "deploy", script), "utf8");
			expect(content).toContain('source "$script_dir/lib/load_config.sh"');
			expect(content).toContain("load_deploy_config");
			expect(content).not.toContain('config="${DEPLOY_CONFIG:-infra/deploy/prod.env}"');
		}
		expect(createAgentSecretsScript).toContain("AWS_REGION is required in $DEPLOY_CONFIG_PATH or env");
	});

	it("image build script only documents supported ECR repositories", () => {
		const buildScript = readFileSync(
			join(root, "scripts", "deploy", "build_and_push_agent_image.sh"),
			"utf8",
		);

		expect(buildScript).toContain('repository="mymemo-agent-chat-api"');
		expect(buildScript).toContain('repository="mymemo-agent-worker"');
		expect(buildScript).not.toContain("ECR_REPOSITORY_PREFIX");
	});

	it("secret bootstrap parses ignored values without sourcing them", () => {
		expect(createAgentSecretsScript).toContain("load_dotenv_file");
		expect(createAgentSecretsScript).not.toContain('source "$secrets_config"');
		expect(createAgentSecretsScript).not.toContain("secret-arns.env");
	});

	it("terraform resolves application secret ARNs from stable secret names", () => {
		const combined = terraformFiles()
			.map((path) => readFileSync(path, "utf8"))
			.join("\n");

		expect(combined).toContain('data "aws_secretsmanager_secret" "llm_token"');
		expect(combined).toContain("llm_token_secret_name");
		expect(combined).toContain("data.aws_secretsmanager_secret.llm_token.arn");
		expect(combined).not.toContain('variable "llm_token_secret_arn"');
		expect(combined).not.toContain("var.llm_token_secret_arn");
	});

	it("deployment env examples satisfy current app env loaders", () => {
		const common = {
			AGENT_DATABASE_URL:
				"postgresql://agent:agent@db.example.com:5432/mymemo_agent",
			DB_SSL: "require",
			DB_PASSWORD: undefined,
			LOG_LEVEL: "info",
			E2B_API_KEY: "e2b_test_key",
		};

		expect(() =>
			loadApiConfigFromEnv({
				...common,
				LLM_TOKEN_SECRET: "test-llm-token-secret",
				GATEWAY_PUBLIC_URL: "https://agent-gateway.example.com",
				STATSIG_SERVER_SECRET: "statsig-test-secret",
				E2B_TEMPLATE: "sandbox-template-prod",
			}),
		).not.toThrow();

		expect(() =>
			loadWorkerConfigFromEnv({
				...common,
				KB_DATABASE_URL: "postgresql://kb:kb@db.example.com:5432/mymemo_kb",
				OPENROUTER_API_KEY: "openrouter-test-key",
				OPENROUTER_BASE_URL: "https://openrouter.ai/api",
				OPENROUTER_DEFAULT_MODEL: "anthropic/claude-sonnet-4",
			}),
		).not.toThrow();
	});
});

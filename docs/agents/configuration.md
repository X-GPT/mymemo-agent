# Configuration and operations

Local AWS commands always select `aws --profile mymemo ...`. Terraform uses
`AWS_PROFILE=mymemo`. GitHub Actions assumes the deploy role through OIDC;
workflow scripts use those credentials without selecting a local profile.

Terraform in `infra/terraform` supplies the front's Function URL, DynamoDB,
workspace bucket, Runtime ARN, Code Interpreter id and Statsig secret ARN.
Runtime configuration is in `agent-runtime.tf`: exact ARM64 image digest,
KB/OpenRouter secret ARNs, model/base URL, pinned CA paths, Code Interpreter
id, workspace bucket and Turn budget. Source loaders are authoritative.

Production secret values stay in Secrets Manager. The three surviving secrets
are KB_DATABASE_URL, OPENROUTER_API_KEY and STATSIG_SERVER_SECRET. Rotation takes
effect when a new process resolves AWSCURRENT.

Keep `fck_nat_ami_id` pinned to the reviewed official ARM64 AMI. Preserve
Runtime private subnets and KB ingress. Release deploy is manually dispatched
from main and requires the typed apply confirmation.

The one-time v1 removal is complete; see [the teardown history](../runbooks/v1-teardown.md).

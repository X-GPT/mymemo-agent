# Production Terraform

This root owns the Lambda front, DynamoDB table, workspace bucket, AgentCore
Runtime, SANDBOX Code Interpreter, Runtime private subnets and fck-nat egress.
It retains the KB operator bridge, KB ingress and legacy artifact bucket.
The shared VPC/subnets come from mymemo-service remote state. ECR and deploy
IAM retain their separate roots in `infra/ecr` and `infra/bootstrap-iam`.

```sh
terraform -chdir=infra/terraform init -backend=false -lockfile=readonly
terraform -chdir=infra/terraform fmt -check
terraform -chdir=infra/terraform validate
```

Production uses `prod.tfvars` plus `TF_VAR_aws_region`, `TF_VAR_aws_account_id`,
`TF_VAR_agent_runtime_image_digest` and `TF_VAR_front_lambda_package`. The
release workflow builds the immutable ARM64 Runtime image and front package.
Local operators select `AWS_PROFILE=mymemo`; CI uses its OIDC deploy role.
Never commit state, plan JSON or secret values.

Before applying the v1-removal commit, follow
[the two-phase teardown](../../docs/runbooks/v1-teardown.md). Removing the
resource definitions alone does not disable the live RDS deletion protection.
The new stack must have no resource changes in the teardown plan.

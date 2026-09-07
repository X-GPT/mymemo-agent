# Deploy and exercise the Lambda front

Issue #742 adds the front half of Spec #732 in us-west-2. The seven lifecycle
routes work independently of `send` and Runtime #750. v1 keeps its ECS release
steps and Statsig secret access until cutover.

## Release

After merge, dispatch `release-deploy.yml` on main with the existing
`apply-mymemo-agent-prod` confirmation. It builds `front.zip` with Bun and the
locked production dependencies and Statsig Linux ARM64 native module, preserves that zip between plan and
apply, then supplies `TF_VAR_front_lambda_package` to Terraform. Local builds:

```sh
bun install --frozen-lockfile
scripts/deploy/build_front.sh
```

`prod.tfvars` supplies the existing API task role, verified against
`mymemo-staging-api:273`. Set `front_agent_runtime_arn` to the new Runtime ARN
once #750 exists; until then the front has no Runtime invoke grant and the
`AGENT_RUNTIME_ARN` value is `pending-runtime-750`. The interpreter id and
workspace bucket are already wired into the Runtime environment for that
follow-on. No `send` demo is claimed by this ticket.

The front reads `STATSIG_SERVER_SECRET_ARN` at cold start (AWSCURRENT); it never
receives a secret value through Terraform. The existing secret is a raw Statsig
server key. Its gate must allow the demo member. Failed initialization or a
closed gate never permits creation. Rotation takes effect in new Lambda
execution environments.

## Operator signing proxy

Use the normal `mymemo` profile (refresh its login first if required). The
operator needs both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` on
`mymemo-agent-prod-front`. Production grants are scoped to the API task role;
operator access comes from the operator's own IAM policy.

```sh
export FRONT_FUNCTION_URL="$(AWS_PROFILE=mymemo terraform -chdir=infra/terraform output -raw front_function_url)"
export FRONT_MEMBER_CODE=codex-smoke
export FRONT_PARTNER_CODE=mymemo
# Optional: FRONT_TEAM_CODE; PORT (3001); FRONT_BROWSER_ORIGIN (http://localhost:3000)
bun run scripts/front-proxy.ts
```

The proxy binds only 127.0.0.1 and signs with the `mymemo` profile for service
`lambda` in us-west-2. It supplies the configured identity rather than trusting
browser identity headers. Only the configured browser origin is allowed;
keep the proxy local and stop it after the demo. Point the prototype's
`DefaultChatTransport` API at `http://127.0.0.1:3001/v1/conversations/<id>/messages`
when `send` lands. Response bodies are relayed as streams, preserving
`x-vercel-ai-ui-message-stream`; requests are capped at 10 MiB and buffered for
payload signing. Redirects are not followed.

## Lifecycle demo

With the proxy running, execute the smoke script; it creates only its own
Conversation and deletes it in `finally`. A 403 on creation means the member
is not enabled in Statsig, not a reason to bypass the gate.

```sh
bun run scripts/smoke/front-lifecycle.ts
```

For direct SigV4 calls without the proxy:

```sh
awscurl --profile mymemo --service lambda --region us-west-2 \
  -H 'X-Member-Code: codex-smoke' -H 'X-Partner-Code: mymemo' \
  "${FRONT_FUNCTION_URL%/}/v1/conversations"
```

The Function URL output ends in `/`; remove that trailing slash before
appending a path for tools that preserve double slashes. Unsigned requests
must return 403. Missing identity on a signed request must return 401.

The sweep runs every five minutes. It deletes paginated `_history/<id>/`,
`_workspace/<id>/`, `_artifacts/<id>/` objects and the exact
`_transcripts/<id>.jsonl` key before clearing DynamoDB items, Tombstone last.
S3 partial failures retain the Tombstone for retry. Inspect
`/aws/lambda/mymemo-agent-prod-front` in CloudWatch if cleanup stalls.

## Verification record

Terraform validate, front and proxy TypeScript checks, proxy SigV4/streaming
and cleanup retry tests pass. All eight initial PR CI checks passed. The
`front-package` CI job also loads the extracted zip in the Node.js 22 ARM64
Lambda image with AWS calls stubbed, exercising the real Statsig native loader.

A front-only Terraform plan contains 19 additions, 0 changes and 0 deletions.
It has not been applied: the pre-merge live demo requires explicit operator
authorization. Normal release remains main-only after merge. No live success
is claimed by these local/CI checks.

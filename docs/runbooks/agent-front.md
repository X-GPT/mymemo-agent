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
`mymemo-staging-api:273`. The now-merged #750 Runtime, shared SANDBOX interpreter
and workspace bucket are reused directly: the front's `AGENT_RUNTIME_ARN`
and invoke grant point at that Runtime, and both services receive the same
`CODE_INTERPRETER_ID`. No v1 Runtime environment changes are needed. This
runbook exercises lifecycle routes; it does not claim a `send` demo.

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
for the text-Turn route. Response bodies are relayed as streams, preserving
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

## Verification record — 2026-09-07 UTC

The operator authorized a targeted pre-merge deployment using profile `mymemo`
in us-west-2. Terraform applied **11 additions, 0 changes, 0 deletions**,
reusing #750's deployed Runtime, workspace bucket and SANDBOX interpreter.
The regular release path remains the main-only Release deploy workflow.

- Source: `022233d7ec69c5481fc1a309f0ee0430706668d9`; subsequent evidence changes
  only update this runbook. All nine CI checks passed for the implementation,
  including the real Node.js 22 ARM64 Lambda cold-start check.
- Deployed zip SHA-256:
  `20be38c4b6b42c1f93089a467d0a5e49071a083f01da2b28a230b9863af09f86`.
  Lambda reports the matching base64 `CodeSha256`,
  `IL44xLa0LB+TCJpGfQpeSQcaCD8B2isoojC5hjrwn4Y=`.
- Lambda `mymemo-agent-prod-front`: Active / Successful, `nodejs22.x`, ARM64,
  timeout 840 seconds. Function URL:
  `https://rl3w46jhxf3uqslmeww4y6ykge0gltbw.lambda-url.us-west-2.on.aws/`;
  auth `AWS_IAM`, invocation `RESPONSE_STREAM`.
- Unsigned GET returned 403. A SigV4-signed GET without identity returned 401.
  The actual Statsig gate permitted the existing `codex-smoke` / `mymemo`
  demo identity; no gate configuration or secret was changed.
- `FRONT_PROXY_URL=http://127.0.0.1:17420 bun run scripts/smoke/front-lifecycle.ts`
  passed through `scripts/front-proxy.ts`, signing with `mymemo`. Conversation
  `3649836e-7852-41ad-996a-14e2927f7ca3`: create 201; list/search and rename 200;
  archive and unarchive 200; empty messages/artifacts 200; missing artifact
  download 404; delete 204; subsequent messages 404.
- Cleanup fixture `3c4c2ed6-407a-437c-af77-57aac512fd9c`: wrote one disposable
  object under each of `_history`, `_workspace`, `_artifacts`, and the exact
  transcript key before deleting the Conversation. Directly invoking the
  Scheduler's `{"source":"mymemo.cleanup"}` payload returned 200 with no
  FunctionError. Strongly consistent DynamoDB reads and S3 listings confirmed
  the Tombstone and all four fixtures were removed.
- The deployed Scheduler is ENABLED with `rate(5 minutes)`, flexible window
  OFF, targeting this Lambda with that same cleanup payload. DynamoDB PITR is
  ENABLED. The cleanup test above explicitly invoked the handler; it does not
  claim to measure the schedule's wall-clock delivery.

Local verification also passed scoped TypeScript, proxy signing/unbuffered
streaming and cleanup retry tests, and all 32 front tests against DynamoDB
Local. This is lifecycle acceptance evidence; no model Turn demo is claimed.

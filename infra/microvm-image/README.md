# MicroVM image — the In-VM server on the platform

The production MicroVM image for the per-Conversation VM ([spec #654](https://github.com/X-GPT/mymemo-agent/issues/654)). #661 proved the platform recipe with a placeholder server; #666 bakes the real In-VM server (`apps/in-vm-server`) as the entrypoint. Derived from the #646 probe kit (`docs/research/microvm-probe` on the `research/microvm-probe` branch).

> **There is no shell in the VM.** `Bash`/`BashOutput`/`KillShell` are denied in `query-options.ts` (ADR-0034 amendment), so the image carries no bubblewrap, no socat, and no sandbox check. Why: sandbox-mode Bash cannot start here — bubblewrap creates namespaces but cannot mount `/proc`, and every Bash call died on that (proven live on #666 with a real Turn; #646's "bwrap PASS at default caps" only exercised namespace creation, never the proc mount the real sandbox performs). Running the shell unsandboxed was rejected — it would hand the untrusted surface the VM's network, and with it IMDS. The agent's tools are the cwd-scoped file tools and the in-process document tools.

## Boot model

The image snapshots the server **unconfigured**: it listens, answers the build's `/ready` hook, and refuses `/nudge` with 503. At `run-microvm` the platform POSTs `/aws/lambda-microvms/runtime/v1/run` with the `runHookPayload` — a JSON object of the same env keys the server reads locally (see [configuration](../../docs/agents/configuration.md)) — and the server configures Turn serving, runs the boot sweep, exec-verifies the CLI binary, and only then returns 200. The platform gates all endpoint traffic until `/run` returns, so a nudge can never reach an unconfigured VM.

## Pipeline

- **Context**: `scripts/deploy/stage_microvm_image_context.sh` assembles this directory plus `app/` — the pruned Bun workspace (`bun install --frozen-lockfile --production --filter in-vm-server` runs at image build). PR builds and registration zip the same staged context.
- **PR**: `.github/workflows/microvm-image.yml` builds the staged context for ARM64 and runs `scripts/smoke/microvm-image-check.sh` (pinned SDK `0.3.251` / CLI binary `2.1.251` on the serving install, root-owned managed settings, non-root `developer` user, and an unconfigured server boot answering `/ready`).
- **Main push**: the same workflow assumes the deploy role and runs `scripts/deploy/register_microvm_image.sh` — stage → zip → S3 (`mymemo-agent-prod-artifacts/microvm-images/`) → `create-microvm-image` (first run) or `update-microvm-image` (after) → poll to `CREATED`/`UPDATED`. Build role: `mymemo-agent-prod-microvm-image-build` (`infra/terraform/microvm-image.tf`). `MICROVM_IMAGE_NAME` overrides the image name for a scratch pre-merge verification build.

## Hand-launch verification (acceptance spot-checks)

Needs AWS CLI ≥ 2.35.10 (`lambda-microvms` service); run operator commands with the `mymemo` profile (`export AWS_PROFILE=mymemo`). Platform corrections, verified live on #646: `get-microvm-image` wants the full **ARN**, build logs live under **`/aws/lambda-microvms/<name>`** (hyphen), `list-microvms` returns `items[]`, and `run-microvm` can throw a transient 502 — retry.

```bash
REGION=us-west-2
IMAGE_ARN=arn:aws:lambda:$REGION:637423444544:microvm-image:mymemo-agent-prod-microvm
CONNECTOR_ARN=$(aws lambda-microvms list-network-connectors --region $REGION \
  --query "items[?name=='mymemo-agent-prod-microvm-egress'].arn" --output text)

# 1. Compose the runHookPayload: Conversation identity, data-plane URLs, and
#    the gateway token (mint with GATEWAY_TOKEN_SECRET from Secrets Manager —
#    see apps/chat-api/src/features/gateway/gateway-token.ts). MODEL_BASE_URL
#    is the gateway route on the internal agent ALB.
PAYLOAD=$(cat <<'JSON'
{"MYMEMO_USER_ID":"<user>","MYMEMO_CONVERSATION_ID":"<conversation>",
 "AGENT_DATABASE_URL":"postgresql://…/mymemo_agent","DB_SSL":"require",
 "KB_DATABASE_URL":"postgresql://…/mymemo_kb",
 "REDIS_URL":"rediss://…",
 "MODEL_BASE_URL":"http://<internal-alb-dns>/v2/gateway/<conversation>",
 "MODEL_API_KEY":"<gateway-token>","MODEL":"<model-id>"}
JSON
)

# 2. Launch through the VPC egress connector (managed ingress; the egress
#    lockdown topology is #660's) with the execution role.
aws lambda-microvms run-microvm --region $REGION \
  --image-identifier "$IMAGE_ARN" \
  --ingress-network-connectors "arn:aws:lambda:$REGION:aws:network-connector:aws-network-connector:ALL_INGRESS" \
  --egress-network-connectors "$CONNECTOR_ARN" \
  --execution-role-arn arn:aws:iam::637423444544:role/mymemo-agent-prod-microvm-execution \
  --run-hook-payload "$PAYLOAD" \
  --idle-policy '{"autoResumeEnabled":true,"maxIdleDurationSeconds":900,"suspendedDurationSeconds":1800}' \
  --maximum-duration-in-seconds 3600
# capture microvmId + endpoint; poll get-microvm until RUNNING — the /run hook
# has already configured the server by then.

# 3. Health + smoke through the JWE-authenticated per-VM endpoint
TOKEN=$(aws lambda-microvms create-microvm-auth-token --region $REGION \
  --microvm-identifier "$VM" --expiration-in-minutes 30 \
  --allowed-ports '[{"port":8080}]' \
  --query 'authToken."X-aws-proxy-auth"' --output text)
curl -sS "https://$ENDPOINT/health" -H "X-aws-proxy-auth: $TOKEN" -H "X-aws-proxy-port: 8080"
curl -sS "https://$ENDPOINT/smoke"  -H "X-aws-proxy-auth: $TOKEN" -H "X-aws-proxy-port: 8080"
# expect every RESULT line PASS (pinned versions, policy tier, writability)

# 4. Queue a Turn (a queued user row in conversation_messages) and nudge; the
#    server claims it, serves it through the gateway, and lands durable
#    history + the Live Stream.
curl -sS -X POST "https://$ENDPOINT/nudge" -H "X-aws-proxy-auth: $TOKEN" -H "X-aws-proxy-port: 8080"

# 5. Always terminate
aws lambda-microvms terminate-microvm --region $REGION --microvm-identifier "$VM"
```

## What stays out (by design)

- Orchestration lives in chat-api (`apps/chat-api/src/features/conversation-vm/`, #669): the `conversation_vm` launch claim, `RunMicrovm` with the minted gateway token in `runHookPayload`, the per-nudge auth token, lazy rehydrate. This runbook drives the same contract by hand for spot-checks.
- Checkpoint/rehydrate and the graceful-drain `/suspend` gate — #670; until then the platform snapshot preserves state across suspend/resume.
- `--additional-os-capabilities` — omitted; nothing in the image needs elevated capabilities now that there is no sandbox to construct.

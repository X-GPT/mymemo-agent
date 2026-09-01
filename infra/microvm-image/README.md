# MicroVM image — the In-VM server on the platform

The production MicroVM image for the per-Conversation VM ([spec #654](https://github.com/X-GPT/mymemo-agent/issues/654)). #661 proved the platform recipe with a placeholder server; #666 bakes the real In-VM server (`apps/in-vm-server`) as the entrypoint. Derived from the #646 probe kit (`docs/research/microvm-probe` on the `research/microvm-probe` branch), whose live run proved the recipe: bubblewrap creates namespaces at DEFAULT capabilities — no `--additional-os-capabilities ALL`.

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
# expect every RESULT line PASS (bwrap namespaces, pinned versions, policy tier)

# 4. Queue a Turn (a queued user row in conversation_messages) and nudge; the
#    server claims it, serves it through the gateway, and lands durable
#    history + the Live Stream.
curl -sS -X POST "https://$ENDPOINT/nudge" -H "X-aws-proxy-auth: $TOKEN" -H "X-aws-proxy-port: 8080"

# 5. Always terminate
aws lambda-microvms terminate-microvm --region $REGION --microvm-identifier "$VM"
```

## What stays out (by design)

- Orchestration (claim/ensure VM, token minting at `RunMicrovm`, nudge from chat-api) — the orchestration ticket; this runbook drives the same contract by hand.
- Checkpoint/rehydrate and the graceful-drain `/suspend` gate — #670; until then the platform snapshot preserves state across suspend/resume.
- `--additional-os-capabilities` — deliberately omitted; default caps are proven sufficient.

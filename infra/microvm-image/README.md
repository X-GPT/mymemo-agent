# MicroVM image skeleton — ticket #661

The production MicroVM image for the per-Conversation VM ([spec #654](https://github.com/X-GPT/mymemo-agent/issues/654)), proven with a placeholder server (`server.mjs`) so the platform risk retires before the real In-VM server (#666) exists. Derived from the #646 probe kit (`docs/research/microvm-probe` on the `research/microvm-probe` branch), whose live run proved the recipe: bubblewrap creates namespaces at DEFAULT capabilities — no `--additional-os-capabilities ALL`.

## Pipeline

- **PR**: `.github/workflows/microvm-image.yml` builds this directory for ARM64 and runs `scripts/smoke/microvm-image-check.sh` (pinned SDK `0.3.251` / CLI `2.1.251`, root-owned managed settings, non-root `developer` user).
- **Main push**: the same workflow assumes the deploy role and runs `scripts/deploy/register_microvm_image.sh` — zip → S3 (`mymemo-agent-prod-artifacts/microvm-images/`) → `create-microvm-image` (first run) or `update-microvm-image` (after) → poll to `CREATED`/`UPDATED`. Build role: `mymemo-agent-prod-microvm-image-build` (`infra/terraform/microvm-image.tf`).

First-run prerequisites (human-applied, in order): bootstrap-iam apply (deploy-role `MicrovmImageRegistration` + artifact-object grants), then a release-deploy Terraform apply (build role).

## Hand-launch verification (acceptance spot-checks)

Needs AWS CLI ≥ 2.35.10 (`lambda-microvms` service); run operator commands with the `mymemo` profile (`export AWS_PROFILE=mymemo`). Platform corrections, verified live on #646: `get-microvm-image` wants the full **ARN**, build logs live under **`/aws/lambda-microvms/<name>`** (hyphen), `list-microvms` returns `items[]`, and `run-microvm` can throw a transient 502 — retry.

```bash
REGION=us-west-2
IMAGE_ARN=arn:aws:lambda:$REGION:637423444544:microvm-image:mymemo-agent-prod-microvm

# 1. Launch (managed ingress/egress; short idle policy so suspend fires quickly)
aws lambda-microvms run-microvm --region $REGION \
  --image-identifier "$IMAGE_ARN" \
  --ingress-network-connectors "arn:aws:lambda:$REGION:aws:network-connector:aws-network-connector:ALL_INGRESS" \
  --egress-network-connectors "arn:aws:lambda:$REGION:aws:network-connector:aws-network-connector:INTERNET_EGRESS" \
  --idle-policy '{"autoResumeEnabled":true,"maxIdleDurationSeconds":120,"suspendedDurationSeconds":1800}' \
  --maximum-duration-in-seconds 3600
# capture microvmId + endpoint; poll get-microvm until RUNNING

# 2. Health through the JWE-authenticated per-VM endpoint
TOKEN=$(aws lambda-microvms create-microvm-auth-token --region $REGION \
  --microvm-identifier "$VM" --expiration-in-minutes 30 \
  --allowed-ports '[{"port":8080}]' \
  --query 'authToken."X-aws-proxy-auth"' --output text)
curl -sS "https://$ENDPOINT/healthz" -H "X-aws-proxy-auth: $TOKEN" -H "X-aws-proxy-port: 8080"

# 3. In-VM smoke: bwrap namespaces, pinned versions, root-owned settings
curl -sS "https://$ENDPOINT/smoke" -H "X-aws-proxy-auth: $TOKEN" -H "X-aws-proxy-port: 8080"
# expect every RESULT line PASS and EXIT 0

# 4. Lifecycle: suspend → resume → health again (hooks are ENABLED on the
#    image; a hook that failed to answer would break this cycle)
aws lambda-microvms suspend-microvm --region $REGION --microvm-identifier "$VM"
aws lambda-microvms resume-microvm  --region $REGION --microvm-identifier "$VM"
curl -sS "https://$ENDPOINT/healthz" -H "X-aws-proxy-auth: $TOKEN" -H "X-aws-proxy-port: 8080"

# 5. Always terminate
aws lambda-microvms terminate-microvm --region $REGION --microvm-identifier "$VM"
```

## What stays out (by design)

- Egress lockdown (VPC connector, no-NAT subnets, SGs) — #660; this image launches with managed egress for verification only.
- The real In-VM server, gateway token, model turns — #666/#659; nothing here holds a credential.
- `--additional-os-capabilities` — deliberately omitted; default caps are proven sufficient.

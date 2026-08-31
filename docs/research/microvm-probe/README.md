# MicroVM probe kit — ticket #646

Answers the eight feasibility items on [Probe a live MicroVM](https://github.com/X-GPT/mymemo-agent/issues/646) — the questions the [product brief](../aws-lambda-microvms-2026.md) left as "verify empirically." The image bakes the confinement bundle from the [SDK-confinement note](https://github.com/X-GPT/mymemo-agent/blob/research/agent-sdk-confinement/docs/research/agent-sdk-tool-confinement-2026.md); measurements live in `probe.sh`, served by `probe-server.mjs`.

## Status: harness ready, live run NOT yet executed

Blocked on tooling: the local AWS CLI (2.34.23) has **no `lambda-microvms` service**, and AWS does not document the minimum CLI version. Resolve one of: upgrade the CLI to a build that ships `lambda-microvms` / `lambda-core`, use an SDK driver (`boto3.client("lambda-microvms")` / `@aws-sdk/client-lambda-microvms`, API version 2025-09-09), or a preview plugin. Until then this kit is complete but unrun.

## The load-bearing item

**Item 2 — unprivileged user namespaces / bubblewrap.** Sandbox-mode Bash rides on it, and nothing downstream (the trust-boundary ticket, the spec) may claim "sandbox mode restricts Bash" until it passes. Hypothesis from the API research: the AL2023 base image ships a **restricted capability set**, and `create-microvm-image --additional-os-capabilities '["ALL"]'` (documented as enabling "mounts, network namespaces, eBPF") is the likely prerequisite. So build the image **twice** and compare — that comparison *is* the finding:

| Image | `--additional-os-capabilities` | Expected `bwrap` result |
| --- | --- | --- |
| A | omitted (default restricted caps) | likely FAIL |
| B | `'["ALL"]'` | likely PASS |

If B fails too, sandbox-mode Bash is not viable on this platform and the map must revisit the "Bash restricted by sandbox mode" destination clause.

## Run order (cheapest-first; egress needs VPC infra)

Fill the ARNs/IDs, then drive with whichever tooling resolves the CLI gap. Field names verified against the API research (service `lambda-microvms`; connector under `lambda-core`).

```bash
# 0. Push the app zip (Dockerfile + probe files) to S3
zip -r app.zip Dockerfile managed-settings.json probe.sh probe-server.mjs
aws s3 cp app.zip s3://$BUCKET/app.zip

# 1. Build image A (default caps) and image B (ALL caps)
aws lambda-microvms create-microvm-image --name probe-A \
  --code-artifact uri=s3://$BUCKET/app.zip \
  --base-image-arn arn:aws:lambda:us-west-2:aws:microvm-image:al2023-1 \
  --build-role-arn $BUILD_ROLE
aws lambda-microvms create-microvm-image --name probe-B \
  --code-artifact uri=s3://$BUCKET/app.zip \
  --base-image-arn arn:aws:lambda:us-west-2:aws:microvm-image:al2023-1 \
  --build-role-arn $BUILD_ROLE \
  --additional-os-capabilities '["ALL"]'

# 2. Run each with public egress first (items 1,2,4,6 need no VPC). Idle policy short so
#    suspend fires quickly for item 6.
aws lambda-microvms run-microvm --image-identifier $IMAGE_A \
  --idle-policy '{"autoResumeEnabled":true,"maxIdleDurationSeconds":120,"suspendedDurationSeconds":1800}' \
  --maximum-duration-in-seconds 3600
#   -> capture microvmId + endpoint

# 3. Auth token (item 7 rides this) and measure
TOKEN=$(aws lambda-microvms create-microvm-auth-token --microvm-identifier $VM \
  --expiration-in-minutes 30 --allowed-ports '[{"port":8080}]' \
  --query 'authToken."X-aws-proxy-auth"' --output text)
curl -sS "https://$ENDPOINT/probe?phase=plant" -H "X-aws-proxy-auth: $TOKEN" -H "X-aws-proxy-port: 8080"

# 4. Item 6: suspend, resume, re-measure — markers must survive
aws lambda-microvms suspend-microvm --microvm-identifier $VM
aws lambda-microvms resume-microvm  --microvm-identifier $VM
curl -sS "https://$ENDPOINT/probe?phase=verify" -H "X-aws-proxy-auth: $TOKEN" -H "X-aws-proxy-port: 8080"

# 5. Item 3 (egress lockdown): create a VPC connector into PRIVATE subnets with NO NAT,
#    SGs allowing only RDS+Redis+gateway, then run a VM with --egress-network-connectors $CONN.
aws lambda-core create-network-connector --name probe-egress \
  --configuration '{"VpcEgressConfiguration":{"SubnetIds":["'$SUBNET'"],"SecurityGroupIds":["'$SG'"],"NetworkProtocol":"IPv4","AssociatedComputeResourceTypes":["MicroVm"]}}' \
  --operator-role $CONN_ROLE
# re-run probe: egress-internet / egress-openrouter must read "blocked", dns-resolve PASS,
# and a real model call through $GATEWAY_URL must succeed.

# 6. Always terminate
aws lambda-microvms terminate-microvm --microvm-identifier $VM
```

## What each RESULT line proves for the map

| RESULT id | Item | A pass means |
| --- | --- | --- |
| `unshare-userns`, `bwrap` | 2 | sandbox-mode Bash is viable (record which cap level it needed) |
| `sdk-import`, `cli-present` | 1 | the SDK loop runs in-VM (no AWS sample proved this) |
| `confine-read-escape`, `confine-config-write`, `policy-immutable` | 4 | the confinement bundle holds live; root-owned policy tier moots #634's overwrite race |
| `egress-internet`, `egress-openrouter`, `egress-gateway`, `dns-resolve` | 3 | no-NAT lockdown kills internet while RDS/Redis/gateway + DNS survive |
| `marker-workspace`, `marker-claude` | 6 | suspend/resume preserves disk; the S3 checkpoint story is only needed for the 8 h cap / VM loss, not per-turn |
| `/stream` SSE smoke | 7 | streaming survives the authenticated proxy |

Open discrepancies to settle in passing (from the API research): `runHookPayload` size (prose 16 KB vs schema 4096 B), and the exact `get-microvm` identifier flag.

## Not covered here (orchestration-level, needs the live account)

- Item 5 (SDK loop *does real work*): a full model turn via the gateway — folded into step 5's model call.
- Item 8 (do suspended VMs consume the regional memory quota): observe `list-microvms` + quota console with one VM suspended, or ask AWS support. Pure observation, no script.

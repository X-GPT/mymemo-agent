# MicroVM /v2 topology rollout

Manual steps around applying the Terraform from ticket #660 (spec #654). The
resources themselves — no-NAT subnets, the MicroVM security group, the VPC
egress connector, the checkpoint bucket, and the IAM roles/grants — are in
`infra/terraform/microvm.tf`; nothing here duplicates them.

## Apply order

1. **Verify the OpenRouter secret exists** in the target account/region:
   `<name_prefix>-<environment>-OPENROUTER_API_KEY` (for example
   `mymemo-agent-prod-OPENROUTER_API_KEY`). Terraform reads it as a data
   source, so a missing secret fails the plan. It already exists in
   production (the AgentCore Runtime consumes it); for a fresh environment,
   create it first and set its value out of band — never through Terraform:

   ```bash
   aws --profile mymemo secretsmanager create-secret \
     --name mymemo-agent-<environment>-OPENROUTER_API_KEY \
     --secret-string '<key>'
   ```

2. **`terraform apply`.** One pass creates everything: subnets and route
   tables, the security group and its ingress counterparts on the agent DB /
   KB DB / Redis / ALB groups, the connector operator role, the connector,
   the checkpoint bucket, the VM execution role, and the chat-api task-role
   and execution-role grants. There is no intra-stack ordering to manage —
   Terraform's dependency graph handles it.

3. **Quota bumps** (Service Quotas console or CLI, deliberately not Terraform
   resources — they are account-level requests reviewed by AWS, not
   idempotent infrastructure):
   - `RunMicrovm` requests per second: default 5 TPS. Request a raise sized to
     expected cold-start/rehydrate bursts before any real traffic cutover.
   - Regional MicroVM memory: us-west-2 defaults to 1,024 GB across all VMs.
     Confirm the default is in place and request a raise per the capacity
     plan. Open question tracked on the lifetime ticket (#650): whether
     suspended VMs count against this quota — ask AWS support with the
     request.

4. **First-apply verification** (staging): the MicroVM IAM action names
   (`lambda:RunMicrovm`, `lambda:CreateMicrovmAuthToken`,
   `lambda:TerminateMicrovm`) and ARN shapes follow the GA security
   documentation; confirm with a live `RunMicrovm` + `CreateMicrovmAuthToken`
   + `TerminateMicrovm` cycle under the chat-api task role before relying on
   them, and tighten if the policy simulator shows drift.

## What this topology asserts

- **Egress lockdown is routing + SGs, no Network Firewall**: the connector's
  subnets have route tables with only the implicit VPC-local route (no NAT,
  no IGW), and the `-microvm-vm` security group's egress reaches exactly the
  agent Postgres, the KB Postgres, the Redis relay, VPC DNS, and port 80 on
  the internal ALB (the gateway route). Verified live on map #644: this
  configuration kills internet egress with full routing.
- **The checkpoint bucket never expires objects.** Idle Conversations
  rehydrate lazily after arbitrary gaps, so lifecycle rules only abort stale
  multipart uploads and transition `conversations/` objects to
  Standard-IA after 30 days. Deletion is explicit via the `pending_cleanup`
  outbox.
- **chat-api holds control-plane authority only**: RunMicrovm / auth-token
  minting / TerminateMicrovm, checkpoint *deletion* under `conversations/*`,
  and `iam:PassRole` for the VM execution role. Checkpoint read/write stays
  with the VM execution role. Suspend/Resume are absent by design — the
  platform idle policy owns them.

## Pre-cutover gate

After applying to staging, run the spec #654 verification gate (egress
positive + negative controls, IMDS block, DNS through the connector, a real
turn through the gateway) before any production cutover. That gate belongs to
the gateway/trust-boundary tickets; this runbook only stands up the topology
it runs against.

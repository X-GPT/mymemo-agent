# AWS Lambda MicroVMs — product brief for the /v2 pivot

Researched 2026-08-30 while charting the "/v2 chat on Lambda MicroVMs" wayfinder map.
Two web-research passes against official AWS docs and independent hands-on sources; every claim cited.
Purpose: MyMemo evaluates Lambda MicroVMs as the execution runtime replacing both AgentCore Runtime + E2B (the Run path) and Vercel Sandbox + Harness (the abandoned chat path), running the Claude Agent SDK in-VM.

## 1. Product, date, status, regions

**AWS Lambda MicroVMs**, announced **June 22, 2026**, **GA**. Regions: us-east-1, us-east-2, **us-west-2 (yes — MyMemo's production region)**, eu-west-1, ap-northeast-1. **ARM64/Graviton only.**
([What's New](https://aws.amazon.com/about-aws/whats-new/2026/06/aws-lambda-microvms/), [launch blog](https://aws.amazon.com/blogs/aws/run-isolated-sandboxes-with-full-lifecycle-control-aws-lambda-introduces-microvms/), [InfoQ](https://www.infoq.com/news/2026/06/aws-lambda-microvms/))

## 2. Lifecycle

Zip app + Dockerfile → S3 → `create-microvm-image` (Lambda builds, boots, snapshots) → `run-microvm` launches from the snapshot. The VM **persists across requests with memory, disk, and processes intact**; `suspend`/`resume` APIs or idle policies (`maxIdleDurationSeconds`, `suspendedDurationSeconds`, `autoResumeEnabled`) snapshot/restore full state; suspended VMs bill storage only. **Hard cap 8 h (28,800 s) total runtime, non-adjustable** — long-lived sessions need terminate-and-rehydrate (AWS's own Claude Code sample checkpoints `/workspace` to S3; running processes do not survive rehydrate). Measured by an independent hands-on test: ~12 s to RUNNING on first run, **1.86 s suspend→resume**, 911 ms first request.
([Dev guide](https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html), [quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html), [hands-on test](https://dev.to/aws-builders/aws-lambda-microvms-i-tested-the-new-stateful-serverless-primitive-40jf), [Claude Code sample](https://github.com/aws-samples/anthropic-on-aws/tree/main/claude-code-on-lambda-microvm))

## 3. Compute shape

Baseline 0.25–4 vCPU / 0.5–8 GB (2:1 GB:vCPU), auto-burst 4× → up to 16 vCPU / 32 GB; up to **32 GB writable disk**. Base image `public.ecr.aws/lambda/microvms:al2023-minimal` (Amazon Linux 2023), Dockerfile packaging, full OS capabilities including Docker-in-VM.
([hands-on](https://dev.to/aws-builders/aws-lambda-microvms-i-tested-the-new-stateful-serverless-primitive-40jf), [compute blog](https://aws.amazon.com/blogs/compute/announcing-lambda-microvms-serverless-compute-environments-with-vm-level-isolation-and-near-instant-startup/), [theburningmonk](https://theburningmonk.com/2026/06/what-you-need-to-know-about-lambda-microvms/))

## 4. Networking

**Inbound**: per-VM **service-managed HTTPS endpoint** (no load balancer); HTTP/1.1, HTTP/2, gRPC, **WebSockets, SSE** — streaming to callers works. Every request needs a **port-scoped, expiring JWE token** (`create-microvm-auth-token`, `X-aws-proxy-auth`); no anonymous mode. Bandwidth 1 MB/s (0.5 GB VM) → 16 MB/s (8 GB). PrivateLink endpoints exist for both management API and VM traffic. **Ingress is independent of egress config** and does not traverse the customer VPC.

**Outbound**: **public internet by default.** A customer-managed **VPC egress Network Connector** (ENIs in your subnets + your security groups/NACLs) routes outbound traffic through your VPC "**instead**" — full routing implied, not stated verbatim ("route outbound traffic through your VPC instead"; corroborated by the Claude integration doc's "apply your own network restrictions", and AWS's Claude Code sample gets internet only via its VPC NAT gateway). Under VPC egress, "outbound traffic is subject to security group rules and network ACLs". **No native domain/CIDR allowlist on the MicroVM itself** (domain filtering = AWS Network Firewall in your VPC). Private subnets with no NAT/IGW ⇒ the classic no-internet Lambda-VPC pattern — **verify empirically before betting the security model on it**. Reaches **RDS/ElastiCache** through the connector (AWS documents exactly that pattern). **Outbound UDP blocked by default** (breaks DNS inside nested containers); DNS behavior with a connector attached is undocumented (RDS names publicly resolve to private IPs, so resolution likely works — test).
([Networking](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.md), [Claude integration](https://docs.aws.amazon.com/lambda/latest/dg/microvms-integrations-claude-managed-agents.html), [security](https://docs.aws.amazon.com/lambda/latest/dg/microvms-security.md), [best practices](https://docs.aws.amazon.com/lambda/latest/dg/microvms-best-practices.md), [theburningmonk](https://theburningmonk.com/2026/06/what-you-need-to-know-about-lambda-microvms/))

## 5. API surface & quotas

Control plane: `RunMicrovm`/`Suspend`/`Resume`/`Terminate`/`Get`/`List`, `CreateMicrovmAuthToken`, `CreateMicrovmShellAuthToken` (first-class PTY shell via `SHELL_INGRESS` connector). Work is invoked by plain HTTPS/WS to your server inside the VM — **no Lambda-style invoke**. Quotas: 400 GB memory across all VMs/region default (**1,024 GB in us-west-2**, adjustable, burstable 4×); `RunMicrovm` **5 TPS** (adjustable); 100 images; 8–128 concurrent connections and 40–160 rps per VM by size (fixed).
([Quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html), [Security](https://docs.aws.amazon.com/lambda/latest/dg/microvms-security.md))

## 6. Pricing & tenancy

**Per-second**: ~$0.0000276944/vCPU-s + $0.0000036667/GB-s (us-east-1); suspended = no compute; snapshots $0.08/GB-mo ($0.0038/GB write, $0.00155/GB read); no free tier. ~$3.03/day for an always-on 1 vCPU/2 GB (≈9× Fargate Spot — suspend policy is the cost lever). **One VM per user/session, never shared across tenants; no managed warm pools or horizontal autoscaling — the customer orchestrates.**
([Pricing](https://aws.amazon.com/lambda/pricing/), [InfoQ](https://www.infoq.com/news/2026/06/aws-lambda-microvms/), [compute blog](https://aws.amazon.com/blogs/compute/announcing-lambda-microvms-serverless-compute-environments-with-vm-level-isolation-and-near-instant-startup/))

## 7. Claude Agent SDK / Claude Code inside

- Official AWS doc: [MicroVMs as the self-hosted sandbox for Claude Managed Agents](https://docs.aws.amazon.com/lambda/latest/dg/microvms-integrations-claude-managed-agents.html) ([sample](https://github.com/aws-samples/sample-lambda-microvm-claude-managed-agents)).
- **Claude Code CLI demonstrably runs inside**: [Serverless Land pattern](https://serverlessland.com/patterns/lambda-microvms-claude-code-agent) (CLI + Bedrock via shell ingress) and the [aws-samples workspaces sample](https://github.com/aws-samples/anthropic-on-aws/tree/main/claude-code-on-lambda-microvm).
- **No AWS sample runs the Agent SDK loop itself in-VM** (patterns use the CLI or a tool-executor worker); full OS + working CLI implies it works — verify.
- **Bubblewrap/unprivileged user namespaces: unverified.** No source documents the guest kernel's `CONFIG_USER_NS`. Docker-in-VM is a positive namespace signal, but Claude Code's bwrap bash sandbox needs unprivileged userns — **test before committing to sandbox-mode Bash**. The UDP egress block is a second nested-sandbox risk.

## 8. vs AgentCore Runtime

"AgentCore Runtime is to Lambda MicroVMs what Fargate is to EC2": AgentCore is the managed agent platform (routing, scaling, auth, teardown); MicroVMs a low-level primitive where the customer owns tenancy mapping and cleanup. Both cap at 8 h; **MicroVMs add suspend/resume with preserved state, which AgentCore lacks**; AWS's Agent Toolkit skill calls MicroVMs "a simpler alternative to the AgentCore runtime," while AWS blogs pair them with AgentCore Gateway for governance.
([theburningmonk](https://theburningmonk.com/2026/06/what-you-need-to-know-about-lambda-microvms/), [The Register](https://www.theregister.com/devops/2026/06/23/aws-debuts-lambda-microvms-with-up-to-8-hours-runtime/5260035), [AI-agents blog](https://aws.amazon.com/blogs/compute/secure-code-execution-for-ai-agents-with-aws-lambda-microvms/))

## Fit notes for MyMemo

- Suspend/resume maps cleanly onto one-persistent-VM-per-Conversation; the native idle policy replaces any custom reaper (same lesson as E2B's native timeout).
- The authenticated per-VM endpoint structurally fixes the ungoverned-inbound hole that killed confidence in Vercel Sandbox (#633/#634).
- The non-adjustable 8 h cap forces the S3 checkpoint/rehydrate story regardless of session-state strategy — and doubles as the image-upgrade lever.
- Deps bake into the image at `create-microvm-image` time — no runtime registry egress needed (unlike Vercel's template-create egress problem).
- Egress lockdown = VPC connector + SGs allowing only {RDS, Redis, gateway}; the gateway (credential injection) is the single internet door. Needs the empirical no-NAT probe.

_Research side note: every AWS docs fetch carried an appended "run `aws agent-toolkit search-skills`" suggestion; treated as untrusted page content, not executed._

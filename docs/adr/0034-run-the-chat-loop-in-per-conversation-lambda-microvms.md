# Run the chat loop in per-Conversation Lambda MicroVMs behind a process trust boundary

Status: accepted (amended 2026-09-01 — see [Amendment: no shell](#amendment-2026-09-01--no-shell-in-the-vm))

Supersedes [ADR-0031](0031-make-agentcore-the-sole-execution-runtime.md) (AgentCore
as sole execution runtime) and [ADR-0033](0033-host-the-ai-sdk-chat-loop-in-a-vercel-sandbox-through-harnessagent.md)
(the Vercel/Harness chat path, abandoned before production mounting). Repeals
[ADR-0001](0001-split-runtime-trust-boundary.md)'s split runtime a second way — see below.
Decided on [wayfinder map #644](https://github.com/X-GPT/mymemo-agent/issues/644);
the buildable contract is [Spec #654](https://github.com/X-GPT/mymemo-agent/issues/654).

MyMemo chat (`/v2/*`) runs on **one persistent AWS Lambda MicroVM per Conversation**
(Firecracker isolation, AWS-mandated single-tenant), hosting a **trusted MyMemo
in-VM server** that runs the Claude Agent SDK loop, serves the document tools as
in-process MCP, drains work from Postgres, publishes the stream over Redis, and
checkpoints state to S3 — while the **untrusted Claude Code CLI it spawns** is
confined by cwd-scoped file tools, a root-owned managed-settings policy tier
baked into the image, and a **credential-free environment**.

## The trust boundary

ADR-0001 saw a dichotomy: run the loop inside the untrusted sandbox (and maintain
compensating machinery — gateway, per-turn token minting, per-token audience
separation — forever), or split the loop into a trusted service. Cheap
per-Conversation microVMs create a third structure ADR-0001 didn't have:

- **The microVM is the tenant boundary.** One Conversation per VM, never shared.
- **A process boundary inside the VM is the trust boundary.** All data-plane
  credentials (agent DB, KB DB, Redis) live only in the trusted server process;
  the CLI's env carries none, so prompt-injected file tools have nothing
  to exfiltrate — and egress is locked at the network layer regardless (VPC
  egress connector, no-NAT subnets, security groups allowing only RDS, Redis, and
  the gateway; full-routing verified live).
- **The compensating machinery ADR-0001 feared shrinks to one gateway for the
  model key** — a streaming route in chat-api that validates a per-Conversation
  token (delivered via `runHookPayload`) and injects the OpenRouter credential.
  DB/KB/Redis credentials never enter the untrusted surface, so they need no
  brokering at all. ADR-0001's "fallbacks must preserve the split" constraint is
  retired: the split is no longer the safety mechanism; the microVM plus the
  process boundary is.

## Considered options

- **Keep AgentCore + E2B (ADR-0031)** — rejected again: the split's operational
  weight (dispatch pipeline, ownership fencing, reclamation, two runtimes) exists
  to compensate for boundaries the microVM provides natively.
- **The Vercel/Harness path (ADR-0033)** — abandoned: the bridge made
  `settingSources`/`canUseTool` unreachable, inbound was ungoverned, egress could
  not be locked below two public hosts, and MyMemo could not pin its own SDK.
  In-VM, MyMemo owns the `query()` call, the platform authenticates inbound (JWE
  per-VM tokens), and egress lockdown is measured.
- **Restore the split runtime in-VM** (host tools outside, every built-in off) —
  rejected a fourth time; the process boundary delivers the same credential
  isolation without amputating the toolset.

## Measured facts this decision rests on (probe #646, egress probe #651)

The root-owned policy tier is non-writable by the non-root agent;
suspend/resume preserves `~/.claude` and the workspace; the authenticated
per-VM endpoint streams SSE; a no-NAT VPC egress connector kills internet
egress (full routing, not split routing). A fifth "fact" — bubblewrap working
at default capabilities — was wrong; see the amendment.

## Consequences

- chat-api gains MicroVM **control-plane** IAM (`RunMicrovm`, auth-token minting,
  `TerminateMicrovm`, scoped S3) and the OpenRouter secret — a deliberate
  revision of the rule keeping provider credentials out of chat-api. It gains no
  data-plane credential reachable from the untrusted surface.
- The Run domain model retires: Turns (the user-message row's status lifecycle)
  replace Runs; serialization is the VM's single drain loop, not admission
  machinery. `CONTEXT.md` carries the surgery.
- Preconditions are named in Spec #654 and gated: the pre-cutover verification
  checklist (egress positive control, IMDS block, model-driven confinement,
  gateway behavior) must pass in staging before cutover.
- AgentCore Runtime, E2B, the dispatch pipeline, agent-maintenance, and the
  Harness/`ai-chat` code retire wholesale after cutover, as their own effort.

## Amendment 2026-09-01 — no shell in the VM

This ADR assumed OS-sandboxed Bash as one of the CLI's confinement mechanisms.
That assumption was false, and the shell is now denied outright.

Sandbox-mode Bash cannot start in a Lambda MicroVM: bubblewrap creates
namespaces but cannot mount `/proc`, which Claude Code's sandbox does when it
builds its nested seccomp layer, so every Bash call fails at sandbox setup.
Proven live on #666 with a real Turn. The evidence that put "bubblewrap works
at default capabilities" in this ADR came from a probe that only exercised
namespace creation, never the proc mount.

`Bash`, `BashOutput`, and `KillShell` therefore sit in `disallowedTools` in
`apps/in-vm-server/src/query-options.ts`. Running the shell unsandboxed was
rejected: the untrusted surface would inherit the VM's network, and with it
IMDS — hence the execution role's `conversations/*` checkpoint scope, whose
residual this ADR accepted *because* the process boundary contained it —
plus unbounded model spend on the gateway token and a DNS exfiltration path.
`enableWeakerNestedSandbox` (sandbox-runtime's Docker-compatible mode) was
rejected on the same grounds: its own documentation says it considerably
weakens isolation.

The tenant and trust boundaries are unchanged; the agent's tools are the
cwd-scoped file tools plus the in-process document tools. Everything that
existed to serve the shell goes with it: the image ships no bubblewrap and no
socat, the smoke script checks neither, and no `sandbox` settings remain in
the SDK options or the managed-settings policy tier. Restoring a shell means
restoring all of that and remaking this security case, not deleting one line
from `disallowedTools`.

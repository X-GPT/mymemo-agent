# #730 probe kit — Code Interpreter + S3 Files on the real us-west-2 topology

Operator-run (the agent's auto-mode classifier blocks resource creation and `ecs run-task`).
Everything is scratch, named `mymemo-ci-probe*`, and torn down by `down.sh`. Cost: cents.

Prereqs: `aws` ≥ 2.36 with profile `mymemo` (admin), `jq`, `bun`. Run from this directory.

| Step | Command | Answers |
| --- | --- | --- |
| 1 | `bash up.sh` | Q1 — S3 Files file system + mount targets in usw2-az1/az2, custom VPC-mode interpreter with the `/mnt/ws` mount. Prints `probe.env`. |
| 2 | `bun install && AWS_PROFILE=mymemo bun run probe.ts \| tee results/probe.log` | Q2 — session start latency (×2), per-call latency, sandbox UID/GID + workdir, mount state, egress (expect none), S3 export lag, persistence across sessions, stopped-session error shape. |
| 3 | `bash nat.sh \| tee results/nat.log` | Q4 — one Fargate task in the **prod** AgentCore private subnets + Runtime SG curls `bedrock-agentcore.us-west-2.amazonaws.com`; exit 4 (HTTP 4xx) = reachable. |
| 4 | `bash down.sh` | Deletes everything (re-run if ENIs are still draining). |

Q3 (pre-minted `Options.sessionId` + `sessionStore` + `resume` on SDK 0.3.251) needs no AWS —
`bun run sdk-session-probe.ts`; the committed `results/sdk-session-probe.log` is the run cited on the ticket.

Paste `results/probe.log` and `results/nat.log` (and any `up.sh` failure) on
[#730](https://github.com/X-GPT/mymemo-agent/issues/730). Already established without resources
(2026-09-05): `aws s3files list-file-systems` answers in us-west-2 (service present, `[]`), and the
account's AZ ids are us-west-2a = usw2-az2, 2b = usw2-az1, 2c = usw2-az3 (all AgentCore-supported).

Notes: `up.sh` is idempotent through `probe.env`; the interpreter's subnets have a route table with
only the local route (the design's "no-route subnets"); the interpreter SG allows egress only to the
mount-target SG on 2049. `probe.ts` mounts via the interpreter's baked-in configuration, so every
session start includes the mount.

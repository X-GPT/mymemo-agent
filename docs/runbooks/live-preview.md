# Live preview operations

Live preview is the optional Redis Pub/Sub path for provisional `text_delta`
frames. Postgres `assistant_text` Run events, projected as cursor-bearing
`text_commit` frames, remain authoritative. A Live alarm must not be used to
fail `/health`, restart tasks, or decide a Run outcome.

## Identify a Live-only incident

The CloudWatch namespace `<name-prefix>-<environment>/LivePreview` contains:

- `Signals`, dimensioned only by bounded `Service` and `Signal` values;
- `MessageOutcomes`, dimensioned only by `Service` and `Outcome`; and
- per-service alarms for repeated degradation, sustained dropped outcomes, and
  sustained queue overflow; and
- a cross-service alarm when both services report degradation.

Each alarm requires two breaching 5-minute periods out of three, so one short
reconnect does not alarm by default.

Production must set `alarm_action_arns` to SNS topics with confirmed incident
subscriptions. An empty list still creates visible CloudWatch alarms but does
not page an operator; do not call that configuration production-ready.

The release evidence and two staging passes for the hard client-contract
cutover are recorded in
[ADR-0008 hard-cutover verification](../verification/adr-0008-hard-cutover.md).

Use this Logs Insights query across the chat-api and agent-worker log groups:

```text
fields @timestamp, service, signal, reason, outcome, count
| filter message = "Live preview signal"
| stats sum(count) by bin(5m), service, signal, reason, outcome
| sort bin(5m) desc
```

Interpret the bounded signals as follows:

- `disabled`: `REDIS_URL` is intentionally absent or invalid for that service.
- `degraded` without a later `recovered` for the same service and reason:
  the Live path is still unavailable. Active degradation repeats a payload-free
  heartbeat every five minutes so a prolonged outage can alarm; a nearby
  `recovered` stops the heartbeat and is a short reconnect.
- `attempted`, `delivered`, and `dropped`: compare these outcomes per service.
  `agent-worker` measures publication; `chat-api` measures projection and
  reconciliation.
- `gap_detected`, `malformed`, `queue_overflow`, `slow_client`, `mismatch`, or
  `impossible_ordering`: the named loss-tolerance path suppressed provisional
  data and waited for the durable commit.

The events contain no Assistant text, provider/tool payload, Redis URL, user
identity, Conversation id, Run id, or Assistant-message id. Do not add any of
those as metric dimensions or Logs Insights grouping fields.

## Confirm durable delivery still flows

1. Check that both service `/health` endpoints remain healthy. This is expected
   during a Live-only incident.
2. Through an authorized conversation request or active-Run reconnect, confirm
   that cursor-bearing `text_commit` frames and a terminal `done` still arrive.
   Missing cursorless `text_delta` frames alone is a Live-only symptom.
3. Confirm Postgres Run events continue to advance without reading their JSON
   payloads:

   ```sql
   SELECT type, count(*)
   FROM run_events
   WHERE created_at >= now() - interval '15 minutes'
   GROUP BY type
   ORDER BY type;
   ```

   Continuing `assistant_text` and `run_done` events prove the authoritative
   path is active.

## Disable the Redis lane

Use the Terraform kill switch; it removes `REDIS_URL` from both ECS task
definitions while leaving Redis provisioned for a quick restore:

First prepare `infra/terraform/generated.auto.tfvars` with the currently
deployed image URIs as described in the Terraform README. Then save and apply
the reviewed plan:

```bash
terraform -chdir=infra/terraform plan -var-file=prod.tfvars -var-file=generated.auto.tfvars -var="live_stream_enabled=false" -out=/tmp/live-preview-disable.tfplan
terraform -chdir=infra/terraform apply /tmp/live-preview-disable.tfplan
AWS_PROFILE=mymemo scripts/deploy/roll_ecs_services.sh
```

Review the plan before apply. It should update the two trusted service task
definitions only; it must not expose the Redis secret or introduce content- or
identifier-bearing monitoring dimensions. The rollout command is required:
Terraform registers the task definitions, while the ECS services intentionally
ignore task-definition drift until that script updates them. After the rollout,
expect one `disabled` signal from each service and continue verifying
`text_commit` plus terminal outcomes.

## Restore the Redis lane

Set the same variable back to `true`, review the plan, apply, and wait for both
services to roll:

```bash
terraform -chdir=infra/terraform plan -var-file=prod.tfvars -var-file=generated.auto.tfvars -var="live_stream_enabled=true" -out=/tmp/live-preview-restore.tfplan
terraform -chdir=infra/terraform apply /tmp/live-preview-restore.tfplan
AWS_PROFILE=mymemo scripts/deploy/roll_ecs_services.sh
```

The rollout is required for the same task-definition reason as disable. Then run
a new conversation turn. Confirm `attempted` and `delivered` outcomes in both
services, one or more cursorless `text_delta` frames, the exact cursor-bearing
`text_commit`, and `done`.

## Recognize a Postgres-path incident

Treat the incident as authoritative-path failure, not Live degradation, if any
of these are true:

- `text_commit` or terminal frames stop even after Redis is disabled;
- `assistant_text` / terminal Run-event counts stop advancing;
- chat-api cannot read the Run event log, the worker cannot append or
  terminalize, or either service health endpoint fails; or
- clients receive durable transport errors rather than merely missing preview.

Escalate through the database/service incident path. Do not tune Live alarms or
restart Redis as a substitute for restoring Postgres delivery.

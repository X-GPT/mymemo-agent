# Downloads and charts demo (#741)

Verified 2026-09-07, 02:50–02:53 UTC, using the actual front, Claude SDK/CLI,
Code Interpreter `mymemo_hand_prod-8hwya8imUU` (`SANDBOX`, `READY`), DynamoDB
Local, MinIO, and the unchanged `AgentProtoReact` island from mymemo-web
`prototype/usechat-front` commit `412252ba41b9d6bacc869338c7dade4792bc47a8`.

The provider was a deterministic Anthropic Messages SSE fixture using the
shape in `apps/agent-runtime/src/runtime.test.ts`, issuing `Bash` then two
`PresentUI` calls. This verifies real SDK/tool execution, not model quality.
A temporary localhost wrapper mounted the island, supplied development identity
headers, and stubbed only its localization functions. It bypassed the BFF and
deployed IAM path; no sibling repository or deployed service was changed.

Conversation: `07ac3a9f-fc7a-4956-b49f-5671cedef64e`.

| Check | Observed result |
| --- | --- |
| Turn 1 (`dee3c34a-49cb-4771-8671-f9683eb0f1c3`) | `Bash` ran Python/matplotlib in the real sandbox and wrote `artifacts/chart.png`. Turn ended `done` at 02:51:03.688 UTC. |
| Immediate download | Downloads listed `chart.png`, 5,089 bytes. The signed URL returned HTTP 200, `image/png`, `attachment; filename*=UTF-8''chart.png`, and the PNG signature. Expiry was 300 seconds. |
| Live UI | `PresentUI` rendered a table (A=2, B=5) and a Vega-Lite bar chart. No PresentUI tool activity appeared. |
| Reload | A full browser reload fetched two persisted messages and rendered both the table and chart again; the download remained listed. |
| Turn 2 (`41f74492-89d3-42c8-ac7b-5b8c62bddf67`) | A fresh sandbox restored the Workspace. `Bash` ran `rm -f artifacts/chart.png`; Turn ended `done` at 02:52:48.546 UTC. |
| Mirror deletion | The stream emitted `removed: ["LFZztLyEt5Ot-JmvtNiN3z6g81JTiBxYEdRnjvh3BK4"]`; the Downloads list became empty. |

## Reproduce with the local stack

Use [README.md](README.md) for the front/stores and
[the Runtime guide](../agent-runtime/README.md) for a provider-backed Runtime.
Use the prototype setup from [DEMO.md](DEMO.md), or mount its `AgentProtoReact`
component against the local front through a development identity adapter.

1. Create a Conversation and ask: “Use Bash and Python/matplotlib to save a
   bar chart to artifacts/chart.png, then use PresentUI to show its data as a
   table and a chart.” The sandbox working directory is `/ws`.
2. When the Turn ends, verify the Downloads entry and download its PNG.
3. Reload the page; verify the table, chart, and download still appear.
4. Ask: “Delete artifacts/chart.png.” Verify the next Turn removes its download.

## Automated checks

```sh
TEST_DYNAMODB_ENDPOINT=http://127.0.0.1:8000 \
TEST_S3_ENDPOINT=http://127.0.0.1:9000 \
  bun test apps/agent-front/src --timeout=30000
bun test apps/agent-runtime/src --timeout=60000
bun test apps/agentcore-runtime/src/ui-payload-validator.test.ts
```

These include real 25 MiB binary chunk assembly, unsafe-path/symlink/size
filtering, edit/delete/no-change mirrors, five-minute signing, owner isolation,
error-Turn publication, whole-reply reload, and a real SDK invalid-PresentUI
retry followed by an accepted table. The validator suite covers all five
components, the 16 KiB cap, and the pinned Vega-Lite schema.

## Review regression: an unchanged next Turn

A follow-up real-sandbox run used Conversation
`c3dea82e-bf92-4563-bb08-01b08617396d`. Turn 1 wrote `artifacts/a.txt` with
mtime `1700000000123456789`, published it, saved the PAX archive, and stopped
session `01M1WX9HY324C92K6GHYESZW00`. Turn 2 restored into fresh session
`01M1WX9MDMNPK1NEWK52Q6GTR7`; mtime was identical and the changed-artifact
count was zero. Both sessions and the test objects were cleaned up.
This also verified Code Interpreter's text-resource response for small UTF-8
artifact chunks. A Linux GNU-tar reproduction confirmed the old default format
rounded `.123456789` to `.000000000`; PAX retained all nine digits.

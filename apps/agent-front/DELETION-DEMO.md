# Deletion demo (#743)

Run against the deployed Front with an enabled Statsig member and the local
`mymemo` AWS profile. The script creates and deletes only its own Conversation;
it never invokes the cleanup Lambda or deletes storage objects directly.

```sh
export FRONT_FUNCTION_URL="$(aws --profile mymemo --region us-west-2 lambda get-function-url-config --function-name mymemo-agent-prod-front --query FunctionUrl --output text)"
export WORKSPACE_BUCKET=mymemo-agent-prod-workspace
export CONVERSATION_TABLE=mymemo-agent-prod-conversations
export FRONT_MEMBER_CODE=codex-smoke
export FRONT_PARTNER_CODE=mymemo
bun run apps/agent-front/scripts/deletion-demo.ts
```

The operator needs signed Front invocation, S3 listing, and DynamoDB Query
permissions. Existing `scripts/front-proxy.ts` provides SigV4 signing directly;
no local HTTP server is required. Credentials and presigned URLs are not logged.

The script asserts two completed real Turns, both reflected in an artifact,
and nonempty `_workspace/<id>/`, `_artifacts/<id>/`, `_history/<id>/`, and the
single `_transcripts/<id>.jsonl` object adopted by the #732 amendment. There is
no SessionStore namespace. It checks DELETE returns 409 during the first Turn,
then obtains a download URL and verifies its contents with HTTP 200. After
DELETE returns 204, all six Conversation routes must immediately return 404.
It polls until the old URL fails (403/404, five-minute bound) and the Scheduler
has removed all four S3 namespaces and every DynamoDB partition item
(ten-minute bound). No manual cleanup invocation can satisfy this check.

## Execution record

Verified on 2026-09-07, 04:01:58–04:05:58 UTC against
`mymemo-agent-prod-front` in us-west-2 using the real deployed Runtime,
Code Interpreter, S3, DynamoDB, and enabled five-minute EventBridge Scheduler.
The script exited 0. No manual sweep or direct storage deletion was used.

Conversation: `7c7ce5dc-cc91-4539-9407-ea415fcdcd90`.

| Check | Observed result |
| --- | --- |
| Two real Turns | Both finished; downloaded `deletion-demo.txt` contained both Turns' text. |
| Processing guard | DELETE during Turn 1 returned 409. |
| Before deletion | Workspace: 1 object; artifacts: 2 (file + manifest); history: 2; transcript: 1; DynamoDB: 3 items. |
| Download before deletion | Presigned URL returned HTTP 200 with both Turns' content. |
| Immediate deletion | DELETE returned 204 at 04:02:25.361 UTC; all six Conversation routes then returned 404. |
| Old URL invalidation | HTTP 404 observed 212,274 ms after requesting the URL, within five minutes. |
| Automatic permanent cleanup | All four S3 namespace listings and the consistent DynamoDB partition Query were empty 212,277 ms after deletion, within ten minutes. |
| Backlog metric | Scheduled invocation `6d6a9e38-214b-4a48-939c-aa164dc22b21` logged `cleanupOldestAgeSeconds: 211.452` at 04:05:56.851 UTC; CloudWatch `mymemo-agent-prod/Front` / `CleanupOldestAgeSeconds` published the same Maximum in Seconds. |
| Alarm and schedule | Alarm threshold 3,600 seconds, GreaterThanThreshold, 300-second period; Scheduler ENABLED, `rate(5 minutes)`, flexible window OFF. |

The deployed package was built from implementation commit `be24f59`, rebased
onto main `9fdefe3` to retain the merged Statsig fix. Package SHA-256:
`20ba2a6e69df13ed228db9b0e753244a86ba1da01f2dd8cc78947dabf4c3a227`.
The deployment changed only the front code and the cleanup metric filter/alarm;
Terraform declares the same monitoring resources. Local verification after
rebasing: 51 front integration tests passed; front TypeScript check passed.

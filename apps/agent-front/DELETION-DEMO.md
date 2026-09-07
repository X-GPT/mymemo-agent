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

Pending deployed execution. Script bundling and Biome checks passed locally;
these checks do not establish the deployed deletion deadlines.

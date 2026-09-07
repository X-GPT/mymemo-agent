# Two-Turn workspace demo (#738)

Run from the repository root with Bun dependencies installed, AWS profile
`mymemo`, and a Code Interpreter in `SANDBOX` mode. The profile needs permission
to start, invoke and stop sessions on that interpreter. MinIO must be available
on `127.0.0.1:9000` with the repository's local development credentials.

```sh
docker compose -f apps/agent-front/compose.yml up -d s3
AWS_PROFILE=mymemo AWS_REGION=us-west-2 \
  CODE_INTERPRETER_ID=<sandbox-interpreter-id> \
  bun run apps/agent-front/scripts/workspace-demo.ts
```

The script uses the Runtime's actual `hand` MCP server through the SDK's
in-memory MCP transport and the front's actual `Workspace` implementation.
Turn 1 creates `notes.txt` through `Write` and `data.csv` through a Python script
in `Bash`, exports the compressed workspace to local S3, and stops its sandbox
session. Turn 2 starts a fresh session, restores that archive, and uses `Bash`
to `cat` both files. An assertion checks their complete contents. A generated 9 MiB random binary
forces multipart export; the script checks the archive size and compares its
SHA-256 digest after restore. Both sessions
are stopped in `finally`, and the unique Conversation's archive is deleted.
The local demo bucket remains available for repeated runs.

## Verified execution

Verified 2026-09-07 with interpreter `mymemo_hand_prod-8hwya8imUU`; the control
API reported `networkMode: SANDBOX` and `status: READY` before the run. Existing
local MinIO was reused.

```text
Conversation f484cfd4-81b4-4853-b638-e00682a0fbbe
Turn 1: session 01M1WRAZAHR0J6SZQCA9AKB1GF
Turn 1: archive 9439205 bytes (multipart)
Turn 1: session stopped
Turn 2: session 01M1WRB40CPGZ6NXQGG9F740R4
Written in Turn 1
name,value
demo,42

9 MiB multipart binary SHA-256 matched: 3a7311393784b2e7455a137f9377d8d14c29517745e1d4197618ce487c66d3d3
Turn 2: archive 9439205 bytes (multipart)
Turn 2: session stopped
PASS: real hand tools and workspace archive survived two sandbox sessions
```

This exercises real Code Interpreter operations, the MCP tool handlers, and
S3 archive persistence across two sessions. It does not invoke a model or the
HTTP Messages endpoint, and it does not verify browser rendering. Those layers
have separate automated tests; the earlier text-only browser demonstration is
recorded in [DEMO.md](DEMO.md).

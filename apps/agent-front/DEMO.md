# Local text-Turn demo (#737)

Verified 2026-09-07 00:55–00:57 UTC with the real `prototype/usechat-front`
React island, BFF, agent-front, DynamoDB Local, Minio, and Runtime container.

- `mymemo-web` prototype commit: `412252ba41b9d6bacc869338c7dade4792bc47a8`
- `mymemo-service` prototype commit: `7b2884dc65b992abe82fbdbacfaf834a847002ae`
- Runtime image: `sha256:e1b98e424aefa47d2ecde016311c0a7d5e36003e81c5c915bf538f22213a8e3a`
- Browser → web `:3001` → BFF `:3002` → front `:3000` → Runtime `:8080`.
- Conversation: `b0047b03-8fe6-40f2-96f0-b9d5c459a347`.

## Results

| Check | Observed result |
| --- | --- |
| Submit through `useChat` | Assistant metadata began `processing`; send was disabled. The streamed response rendered `Hello from fake model.` and ended `done`, with `useChat` ready. First Turn: `152d51dd-196d-4579-bf14-dd9d6c22451c`, 00:55:14–00:55:25 UTC. |
| Concurrent submit | Prototype **force send** returned HTTP 409 with `error: processing` and active Turn `f7a9bb4d-a9a2-439d-8d9d-cf57e3d38075`; BFF logged the 409 at 00:55:50 UTC. |
| Reload during Turn | Browser reload at 00:55:55–00:55:56 returned three committed messages: first Turn user/assistant and second Turn user with `status: processing`. It did not reconnect the stream. |
| Completion after browser disconnect | A later history reload returned four messages, both Turns `done`, with the second reply intact. Second Turn ended 00:55:56.537 UTC. Rejected overlap text was absent. |
| Repeated submit | Third Turn `a3ed74eb-6a14-4a49-b5a1-d60dad7d97af` completed 00:56:46 UTC; the browser displayed all three replies. |
| History object access | Direct `PutObject` followed by `GetObject` in `mymemo-history` returned the written value. |

The provider was the existing fake Anthropic Messages fixture from
`apps/agent-runtime/src/runtime.test.ts`, served on localhost `:8090` with a
one-second delay between events. The Runtime image used its actual pinned
Claude SDK/CLI, not an injected query implementation. No OpenRouter key was
available; this verifies transport, admission, streaming, persistence and
reader-disconnect behavior, not a live provider or model quality. Artifact
and generative UI behavior remain outside this text-only issue.

## Reproduce

Start the local stores and front using the instructions in [README.md](README.md).
Build and run the real Runtime (substitute real provider settings for a live
model test):

```sh
docker build -f apps/agent-runtime/Dockerfile -t mymemo-runtime-737 .
docker run --rm --name mymemo-runtime-737 -p 127.0.0.1:8080:8080 \
  -e OPENROUTER_API_KEY=fake-token \
  -e OPENROUTER_BASE_URL=http://host.docker.internal:8090 \
  -e OPENROUTER_DEFAULT_MODEL=fake mymemo-runtime-737
```

Use throwaway copies of the two prototype branches; no sibling repository
changes are needed. In the service copy:

```sh
COMPAT_LEGACY_LOGIN_ENABLED=true HZ_TOKEN=x GZ_API_KEY=x \
CHAT_SESSION_LOCK_ENABLED=false MYMEMO_AGENT_CHAT_API_URL=http://localhost:3000 \
uv run --frozen uvicorn src.main:app --port 3002
```

Run the web copy with `node node_modules/vite/bin/vite.js --mode locality --port 3001`
and open `http://localhost:3001/agent-proto`. Use **dev login**, **+ new**,
**send**, **force send**, and reload as above. When reusing sibling dependencies,
set the throwaway Vite copy's `cacheDir` to its own temporary directory.

## Budget-result verification

A separate real pinned CLI `0.3.251` budget probe using the existing Runtime
test harness returned `type: result`, `subtype: error_during_execution`,
`is_error: true`, `terminal_reason: aborted_streaming`, with diagnostic details
only in `errors`. The converter regression test covers this observed result
shape and maps it to `budget_exceeded` without exposing those diagnostics.

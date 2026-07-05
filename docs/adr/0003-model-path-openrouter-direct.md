# Model path: direct OpenRouter from agent-worker

Status: accepted

`agent-worker` sends Claude Agent SDK model traffic directly to OpenRouter's
Anthropic-compatible Messages endpoint (`ANTHROPIC_BASE_URL` +
`ANTHROPIC_AUTH_TOKEN`), not to Anthropic first-party and not through the
gateway. The reason is provider flexibility: MyMemo does not want to be
vendor-locked to Anthropic and plans to route to cheaper models later;
OpenRouter keeps the agent harness unchanged while the underlying model can
change.

## Considered Options

- **Direct Anthropic** — first-party behavior for prompt caching, token
  counting, and streaming; no middleman fee or extra failure point. Rejected
  as the default because it hard-couples the model path to one vendor.
- **Direct OpenRouter** (chosen) — one API surface across providers at the
  cost of a fee margin, a second point of failure, and a compatibility layer
  that does not implement the full Anthropic surface (`count_tokens` is
  absent and fails closed).

## Consequences

- Direct Anthropic is the named contingency, not a discarded option: the
  worker's provider config must keep both shapes valid so a failed
  OpenRouter smoke test (streaming, tool use, cancellation, caching,
  token counting) is fixed by an env flip, not a code or architecture
  change.
- Prompt caching is the dominant cost lever for agentic loops; OpenRouter's
  cache passthrough must be measured against first-party, because a small
  cache regression outweighs the routing fee.
- The harness stays the Claude Agent SDK, which is Anthropic-shaped. Each
  future cheaper model is a per-model compatibility gate (tool-calling
  fidelity, thinking blocks, cache semantics), not a free swap.

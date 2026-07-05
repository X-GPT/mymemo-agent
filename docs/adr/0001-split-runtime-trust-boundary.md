# Move the agent loop into trusted Fargate (split runtime)

Status: accepted

The agent control loop moves out of the E2B sandbox into a trusted
`agent-worker` Fargate service; E2B keeps only untrusted filesystem/shell
execution on a persistent workspace. The load-bearing reason is the trust
boundary, not upgrade mechanics: while the loop runs inside a
prompt-injectable sandbox, every trusted capability requires external
compensating machinery (gateway, per-turn token minting, per-token audience
separation — and another audience + gateway route family for each future
capability). Moving the loop deletes that machinery instead of maintaining it.

## Considered Options

- **Versioned agent-bundle download at sandbox hydration** — solves the
  trigger problem (Claude Code/agent upgrades forcing E2B template rebuilds,
  warm-sandbox drain, rehydration) without any re-architecture. Rejected: it
  keeps the compensating machinery forever, adds hydration latency, and adds a
  supply-chain surface inside the sandbox.
- **Split runtime** (chosen) — accepted.

## Consequences

- Fallbacks must preserve the split. If a prototype gate fails (e.g. E2B
  pause/snapshot durability), the fallback is a different persistence design
  under the split runtime — not a return to the in-sandbox agent path.
- The gateway/token machinery loses its reason to exist once the split path
  is the serving path.

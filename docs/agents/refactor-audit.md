# Progressive-disclosure refactor audit

This audit records the contradiction decision and the original instructions flagged for deletion while refactoring `AGENTS.md`.

## Resolved contradiction

The original file both described `apps/chat-api/src/db/` as a thin binding over shared migrations and implied that chat-api owned a local `drizzle/` directory. The selected version is:

> `packages/agent-db` owns the Drizzle schema and migrations. chat-api binds the shared schema and runs the package migrations through `MIGRATIONS_DIR`.

## Flagged for deletion

| Original instruction | Reason | Disposition |
| --- | --- | --- |
| “This file provides guidance to coding agents…” and the sourced behavioral-guidelines preamble | Redundant meta-commentary; an agent already knows the purpose of `AGENTS.md` | Deleted |
| “Don't assume. Don't hide confusion. Surface tradeoffs.” and similar slogans | Overly obvious without adding repository-specific behavior | Replaced with one actionable root constraint |
| “If you write 200 lines and it could be 50, rewrite it.” | Vague threshold that cannot be applied consistently | Deleted |
| “Would a senior engineer say this is overcomplicated?” | Subjective and not independently verifiable | Deleted |
| “No error handling for impossible scenarios.” | Vague and unsafe beside the repository's fail-closed boundaries | Deleted |
| The generic three-step plan template and validation examples | Agents already know standard plan/test loops; no repository-specific information | Condensed into verification guidance |
| “These guidelines are working if…” | Non-actionable success commentary | Deleted |
| Repeated paragraphs assigning model, KB, E2B, relay, and artifact responsibilities | Redundant within the original trust-boundary section | Consolidated in `security.md` |
| `docker-compose up` | Stale: the repository has no Docker Compose file | Deleted |

Actionable scope and verification preferences remain in [Working agreements](working-agreements.md).

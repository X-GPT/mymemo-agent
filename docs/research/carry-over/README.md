# Carry-over from deleted homes

Files preserved before their owning app was deleted (map #719, ticket #718), because the [reuse audit](https://github.com/X-GPT/mymemo-agent/issues/722) found the target shape reuses them:

- `doc-tools.ts` / `doc-tools.test.ts` — from `apps/in-vm-server/src/`: the in-process MCP wiring of `@mymemo/document-tools` (per-call frozen-Scope binding, in-flight Turn ref, docs-cache materialisation). The Runtime's Code Interpreter hand reuses this shape.

Reference only; not compiled, not tested.

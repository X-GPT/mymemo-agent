# Development and verification

Use Bun workspaces: `bun install --frozen-lockfile`, then `bun run test`.
The root runner isolates each workspace in its own process. For a narrow
check, run `bun run --cwd apps/agent-front test` or
`bun run --cwd apps/agent-runtime test`.

Biome formats TypeScript with tabs and double quotes and organizes imports:
`bunx biome check <changed-files>`. Skip unrelated formatting changes.
There is no root build or typecheck script; Biome is not a typecheck.

Package the front with `scripts/deploy/build_front.sh`. Build the Runtime
with `docker build --platform linux/arm64 -f apps/agent-runtime/Dockerfile .`.
The image workflow runs SDK checks on native ARM64.

Front database integration tests require `TEST_DYNAMODB_ENDPOINT` pointing
at DynamoDB Local; CI supplies it on port 8000. Hand tests need Python and
ripgrep. Run Terraform init with `-backend=false -lockfile=readonly`, then
`terraform -chdir=infra/terraform validate` and `fmt -check`.

# Custom E2B sandbox template (`mymemo-agent-sandbox`)

The agent's `Grep` tool and Bash filename discovery use `rg` inside the run sandbox. Secure
artifact publication uses `python3` to pin validated files by descriptor before
streaming them. E2B's stock `base` template ships Python but lacks ripgrep, so
every run sandbox uses this custom template and verifies both runtime tools.
The Runtime references it by
the **required** `WORKER_E2B_TEMPLATE` config — the Runtime refuses to boot
without it.

## What the template contains

Defined code-first in [`template.ts`](template.ts) with the E2B Template SDK
(the `e2b` package this workspace already depends on). The toolchain is
pinned so rebuilds are reproducible:

- **Base image**: `e2bdev/base` (the image behind E2B's stock `base`
  template) pinned by manifest digest — neither Docker Hub's tags (a moving
  `latest` plus unversioned packaging experiments) nor the SDK's
  `fromBaseImage()` (no version parameter) offer a versioned reference, so
  the digest is the only stable pin.
- **ripgrep**: the official `ripgrep_<version>-1_amd64.deb` release artifact,
  verified against its published sha256 before install.
- **python3**: shipped by the base image and verified because secure artifact
  publication uses it for descriptor-pinned reads.

To bump a pin, edit the constants in `template.ts`, then rebuild and
re-verify.

## Build

```bash
# From apps/agentcore-runtime (E2B_API_KEY comes from .env or the environment):
bun run template:build            # builds/updates the alias mymemo-agent-sandbox
bun run template:build my-name    # optional: build under a different name/tag
```

## Verify (Task 9.2 acceptance)

Creates a sandbox from the template and asserts `rg --version` and
`python3 --version` both succeed, then kills the sandbox. Exits non-zero on
failure.

```bash
bun run template:verify                     # defaults to $WORKER_E2B_TEMPLATE, then the alias
bun run template:verify my-name             # or an explicit name/id
```

## Deploy flow

The deploy pipeline's "build or verify the E2B executor template" stage
(design doc, deployment order step 3) is exactly these two commands run in
sequence. The template only changes when this directory does, so routine
service deploys need `template:verify` at most; run `template:build` when the
pins or the definition change.

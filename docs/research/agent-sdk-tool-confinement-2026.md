# Claude Agent SDK Tool Confinement on the Version MyMemo Would Pin

**Research date: 2026-08-30.** This note resolves
[What is the Claude Agent SDK's tool-confinement surface on a MyMemo-pinned version?](https://github.com/X-GPT/mymemo-agent/issues/645)
(part of map [#644](https://github.com/X-GPT/mymemo-agent/issues/644)). It enumerates, against
primary sources only, the settings bundle that delivers (a) Read/Write/Edit/Grep confined to the
working directory, (b) sandbox-mode Bash, and (c) closed config-attack routes — and whether a
root-owned `/etc/claude-code/managed-settings.json` baked into a VM image moots
[#634](https://github.com/X-GPT/mymemo-agent/issues/634)'s "can the process user overwrite /etc?"
concern.

Sources: the `@anthropic-ai/claude-agent-sdk` **0.3.251** npm tarball (`sdk.d.ts`, whose JSDoc is
the generated settings/options reference; `package.json` declares `"claudeCodeVersion": "2.1.251"`),
the official Claude Code docs at `code.claude.com/docs` as read on the research date
([sandboxing](https://code.claude.com/docs/en/sandboxing),
[permissions](https://code.claude.com/docs/en/permissions),
[settings](https://code.claude.com/docs/en/settings),
[managed settings](https://code.claude.com/docs/en/managed-settings),
[Agent SDK: Claude Code features](https://code.claude.com/docs/en/agent-sdk/claude-code-features),
[Agent SDK: permissions](https://code.claude.com/docs/en/agent-sdk/permissions),
[Agent SDK: secure deployment](https://code.claude.com/docs/en/agent-sdk/secure-deployment)),
and the measured results in [#634](https://github.com/X-GPT/mymemo-agent/issues/634) (on 0.3.213).
Line numbers below are into `sdk.d.ts` of the 0.3.251 tarball.

## Short answer

**Pin `@anthropic-ai/claude-agent-sdk` 0.3.251 (exact).** It is the npm `latest` (published
2026-08-28; `next` points at the same version — there is no other stable channel), and it bundles
Claude Code CLI 2.1.251, which is past every version gate the confinement surface needs
(Read-deny-blocks-Write needs 2.1.228; sandbox `strictAllowlist` needs 2.1.219;
`settingSources`-exclusion applying to sandbox config needs 2.1.246). Everything in this note
except those late version gates is also present in the 0.3.233 agentcore-runtime pins today — the
mechanism #634 measured on 0.3.213 is unchanged.

The bundle is three parts, none individually sufficient, together closing every enumerated route:

1. **`query()` options**: `settingSources: []`, `strictMcpConfig: true`, `permissionMode: 'dontAsk'`,
   scoped `allowedTools` (`Read(./**)`, `Edit(./**)`), `disallowedTools` for unwanted tools,
   `sandbox: { enabled, failIfUnavailable: true, allowUnsandboxedCommands: false, ... }`, and
   `env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }`.
2. **A root-owned `/etc/claude-code/managed-settings.json`** baked into the image carrying the
   config-path `permissions.deny` rules from #634 (extended — see below), sandbox enforcement
   keys, and `disableBypassPermissionsMode`. Because the agent user is non-root, the OS itself now
   guards the file; #634's timing race is gone.
3. **Dockerfile/image facts**: non-root agent user; `/etc/claude-code` `root:root` `0755` with
   `managed-settings.json` `0644`; `bubblewrap` + `socat` installed (+ optional
   `@anthropic-ai/sandbox-runtime` seccomp filter); unprivileged user namespaces available in the
   guest kernel — the availability probe is ticket
   [#646](https://github.com/X-GPT/mymemo-agent/issues/646), not this note.

## 1. `settingSources`

Type: `settingSources?: SettingSource[]` with `SettingSource = 'user' | 'project' | 'local'`
(sdk.d.ts L2056, L8032).

- **Default (omitted): all three sources load.** "When omitted, all sources are loaded (matches
  CLI defaults). Pass `[]` to disable filesystem settings (SDK isolation mode). Must include
  `'project'` to load CLAUDE.md files." (sdk.d.ts L2049–2055). The SDK docs repeat it: "Omitting
  `settingSources` is equivalent to `["user", "project", "local"]`"
  ([claude-code-features](https://code.claude.com/docs/en/agent-sdk/claude-code-features)). This
  matches what #631/#634 established on 0.3.213 — the bridge leaving it unset is what made the
  settings-hook route real.
- **`[]` stops these files being read**: `~/.claude/settings.json` (user), `<cwd>/.claude/settings.json`
  and project hooks (project), `<cwd>/.claude/settings.local.json` and `CLAUDE.local.md` (local),
  all CLAUDE.md/rules files, and project/user **skills, commands, and subagents** — skill/agent
  discovery rides the `project`/`user` sources
  ([claude-code-features](https://code.claude.com/docs/en/agent-sdk/claude-code-features), source
  table). Since 2.1.246, excluding a source also drops its `sandbox.filesystem` entries, its
  `Edit` permission rules, and its `Read` deny rules from the sandbox configuration
  ([sandboxing](https://code.claude.com/docs/en/sandboxing#configure-sandboxing)).
- **What `[]` does NOT stop** (documented under "What settingSources does not control",
  [claude-code-features](https://code.claude.com/docs/en/agent-sdk/claude-code-features)):
  - **The managed policy tier is always read** — "Agent SDK sessions load managed settings even
    when `settingSources` excludes the user, project, and local files"
    ([managed-settings](https://code.claude.com/docs/en/managed-settings)); also sdk.d.ts L2923:
    "Pass `[]` to skip user/project/local sources — the managed-settings policy tier is still read
    from disk." This is what makes the baked policy file work under `settingSources: []`.
  - **`~/.claude.json` global config: "Always read."** Relocatable only via `CLAUDE_CONFIG_DIR`.
    This is #634's route 4 (`mcpServers` in legacy user config) — still open on 0.3.251, closed
    by `strictMcpConfig` + the path deny below.
  - **Auto memory** at `~/.claude/projects/<project>/memory/` is loaded into the system prompt
    regardless; disable with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in `env`.
  - **claude.ai MCP connectors** load only when the session authenticates with a claude.ai login —
    not MyMemo's path (API key via gateway) — and `strictMcpConfig: true` suppresses them anyway.
  - `sandbox.credentials` deny entries in `~/.claude/settings.json` still apply as restrictions.

  The docs' multi-tenant warning is exactly MyMemo's shape: "run each tenant in its own filesystem
  and set `settingSources: []` plus `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in `env`."

## 2. `permissions` — rules, semantics, and the cwd boundary

### Evaluation order

Documented as six steps ([agent-sdk/permissions](https://code.claude.com/docs/en/agent-sdk/permissions)):
**hooks → deny rules → ask rules → permission mode → allow rules → `canUseTool`**. First match
wins; "rule specificity doesn't change the order," so a deny can never be carved open by a
narrower allow ([permissions](https://code.claude.com/docs/en/permissions#manage-permissions)).
Deny rules bind "even in `bypassPermissions` mode." A bare tool name in deny removes the tool from
Claude's context entirely; a scoped rule leaves the tool visible and blocks matching calls.

### Rule syntax for the file tools

- **Only `Read(path)` and `Edit(path)` are consulted for file permission checks.** "`Edit` rules
  apply to all built-in tools that edit files" (Write and NotebookEdit included); a
  `Write(path)`/`Glob(path)`/`NotebookEdit(path)` rule "is accepted but never consulted", with a
  startup warning (2.1.210+) ([permissions](https://code.claude.com/docs/en/permissions#read-and-edit)).
- **Read rules reach Grep/Glob best-effort**: "Claude makes a best-effort attempt to apply `Read`
  rules to all built-in tools that read files like Grep and Glob, to `@file` mentions … Grep and
  Glob search the directory the `path` argument resolves to. Claude Code applies `Read` deny rules
  to that directory." (same page).
- **A `Read` deny also blocks Edit/Write on the same path** (edits 2.1.208+, writes 2.1.228+ —
  another reason to pin 0.3.251 over 0.3.213's CLI 2.1.213). NotebookEdit is not covered by that
  coupling, so paths that must be immutable need an `Edit` deny as well.
- **Gitignore pattern syntax, four anchors** ([permissions](https://code.claude.com/docs/en/permissions#read-and-edit)):

  | Pattern | Meaning |
  | --- | --- |
  | `//path` | absolute from filesystem root |
  | `~/path` | from `$HOME` |
  | `/path` | relative to the settings source (project settings → primary working dir; **user settings → `~/.claude`**; `--settings <file>` → the file's directory) |
  | `path` / `./path` | relative to the current working directory |

  `*` matches within a segment, `**` across directories. A bare filename matches at any depth
  under its anchor (`Read(.env)` ≡ `Read(**/.env)`). One asymmetry to know: a single-segment
  relative directory pattern like `src/**` matches only `<cwd>/src` as an **allow** rule but a
  `src` directory at **any depth** as a deny/ask rule. Symlinks: allow rules require both link and
  target to match (else prompt); deny rules fire if **either** matches.
- These rules are "enforced by Claude Code, not by the model" — a permission gate on the built-in
  tools, not OS enforcement. "They don't apply to arbitrary subprocesses that read or write files
  indirectly… For OS-level enforcement… enable the sandbox" (same page, Warning). Read/Write/Edit
  do not run inside the Bash sandbox ([sandboxing](https://code.claude.com/docs/en/sandboxing#scope):
  "Built-in file tools: Read, Edit, and Write use the permission system directly").

### What the default cwd boundary actually permits

- Read-only tools (Read, Grep, Glob) need **no approval "within the working directory and
  additional directories"** ([permissions](https://code.claude.com/docs/en/permissions#permission-system)).
  Outside that scope a permission request fires (the `CanUseTool` options even carry
  `blockedPath`, "when a Bash command tries to access a path outside allowed directories" —
  sdk.d.ts L222–226).
- In non-interactive SDK use **without** `canUseTool`, an unresolved request is a terminal denial:
  "Without one (bare `-p` / SDK `query()` with no canUseTool), 'ask' decisions are terminal, so
  this event also covers those implicit denials" (sdk.d.ts L4666). So the default boundary fails
  closed for out-of-cwd reads — **unless an allow rule approves them**.
- **A bare `Read` in `allowedTools` auto-approves every Read call anywhere on disk** — the SDK
  even warns (`CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`): "Each bare `allowedTools` entry such as
  `"Read"` … auto-approves that whole tool"
  ([agent-sdk/permissions](https://code.claude.com/docs/en/agent-sdk/permissions)). **Do not rely
  on the cwd default while also allowing the bare tool.** Confinement = scoped allows
  (`Read(./**)`, `Edit(./**)`) + `permissionMode: 'dontAsk'` (which hard-denies anything not
  pre-approved and never calls `canUseTool`; sdk.d.ts L1826) + explicit denies on the sensitive
  path classes as the belt.
- `additionalDirectories`: `Options.additionalDirectories` (absolute paths, sdk.d.ts L1398–1401)
  is passed to the CLI as `--add-dir`, which both grants file access **and** loads that
  directory's skills/commands/subagents — but those load "through the `project` setting source, so
  they don't load when you exclude that source" — i.e. `settingSources: []` keeps `--add-dir`
  purely a file-access grant ([permissions](https://code.claude.com/docs/en/permissions#additional-directories-grant-file-access-not-configuration)).
  The settings key `permissions.additionalDirectories` grants file access only.

## 3. The managed-settings policy tier

- **Path (Linux and WSL): `/etc/claude-code/managed-settings.json`**, plus an optional
  **`managed-settings.d/*.json` drop-in directory** and **`managed-mcp.json`** in the same
  directory ([managed-settings](https://code.claude.com/docs/en/managed-settings)). Any deny/ownership
  scheme must cover the whole directory, not just the one file — drop-ins merge in (lists union),
  so a plantable drop-in would widen the policy. #634's `Write(//etc/claude-code/**)` deny already
  covered this; root ownership of the directory covers it at the OS level.
- **Precedence: highest of all tiers.** "Managed settings … Nothing you set overrides them" —
  order is managed > `--settings`/CLI (the SDK options tier) > `.claude/settings.local.json` >
  `.claude/settings.json` > `~/.claude/settings.json`
  ([settings](https://code.claude.com/docs/en/settings#settings-precedence)); confirmed in practice
  by #634 (policy beat user-scope hooks). A short list of security keys let a **stricter** lower
  value win (e.g. `enableArtifact: false`) — nothing that loosens.
- **Which keys it accepts: all of them.** "Every mechanism carries the same policy keys as a
  `settings.json` file" ([managed-settings](https://code.claude.com/docs/en/managed-settings#choose-a-delivery-mechanism)),
  plus ~20 managed-only lock keys (`allowManagedPermissionRulesOnly`, `allowManagedHooksOnly`,
  `allowManagedMcpServersOnly`, `strictPluginOnlyCustomization`, `disableSideloadFlags`,
  `policyHelper`, `sandbox.network.allowManagedDomainsOnly`,
  `sandbox.filesystem.allowManagedReadPathsOnly`, …). So yes, `permissions.deny` is an ordinary,
  fully honored policy key. **The "restrictive-key allowlist" #634 worried about applies only to
  the SDK `managedSettings` *option*** (parent-supplied policy, sdk.d.ts L2024–2045): that value
  is "filtered restrictive-only: permissive arrays (`permissions.allow`, `additionalDirectories`,
  `allowedMcpServers`, …) … are silently dropped", and it is **dropped entirely by default when an
  on-disk admin tier exists** unless that tier sets `parentSettingsBehavior: "merge"` (sdk.d.ts
  L2024–2032, L7365). Since MyMemo bakes a file, put the whole policy in the file and skip the
  `managedSettings` option (or set `parentSettingsBehavior` deliberately).
- **Invalid managed entries fail soft-with-teeth**: repairable entries are skipped with warnings,
  a still-invalid top-level key is dropped, the rest stays enforced — and a table of enforcement
  keys "fail closed" (e.g. invalid `allowedMcpServers` → empty allowlist)
  ([managed-settings](https://code.claude.com/docs/en/managed-settings#invalid-entries-in-managed-settings)).
- **Does baking it root-owned/read-only moot #634's concern? Yes.** #634 measured (0.3.213, Vercel
  Sandbox) that the Claude process ran as the same unprivileged user that owned
  `/etc/claude-code/managed-settings.json`, so the model's own `Write` could flip the policy and
  only the per-turn `onSession` re-write saved it ("the guarantee is timing, not ownership"). In a
  MyMemo-built image with the file `root:root 0644` in a `root:root 0755` directory and the agent
  running as a non-root user, the write fails at the OS layer no matter which tool attempts it —
  Write/Edit, Bash, or any subprocess. The docs' own framing of the residual risk is "a developer
  who is an administrator on the machine can edit the managed source itself"
  ([managed-settings](https://code.claude.com/docs/en/managed-settings#what-a-developer-can-change)) —
  the agent user is not one. Keep the #634 deny rules anyway: they are free, they produce a clean
  policy denial instead of an EACCES tool error, and they keep covering `~/.claude/**` and
  `<cwd>/.claude/**`, which stay owned by the agent user because the CLI must write its transcript
  there. One prerequisite from the environment side: nothing host-side may write into
  `/etc/claude-code` after boot (the #634 probe's `onSession` writer is retired by the image bake).

## 4. Sandbox-mode Bash

### Enablement surface (0.3.251)

Three doors, one schema (`SandboxSettings`, sdk.d.ts L3062–3163):

1. **SDK option** `sandbox?: SandboxSettings` on `query()` (sdk.d.ts L2003) — lands in the
   CLI-flag settings tier.
2. **Settings key** `sandbox` in any settings file, including managed
   (sdk.d.ts L7398+; [settings-reference — sandbox settings](https://code.claude.com/docs/en/settings-reference#sandbox-settings)).
   Several sub-keys are honored only from user/managed/`--settings` and ignored in project files:
   `strictAllowlist`, `tlsTerminate`, `filesystem.disabled`, credential `mask` entries,
   `allowAppleEvents` (per-key JSDoc, sdk.d.ts L7416–7468).
3. **Tool input**: the model may retry a failed command with `dangerouslyDisableSandbox: true` —
   the escape hatch. `allowUnsandboxedCommands: false` makes that parameter "completely ignored"
   (sdk.d.ts L7406; [sandboxing](https://code.claude.com/docs/en/sandboxing#the-unsandboxed-retry-escape-hatch)).

Key knobs: `enabled`, `autoAllowBashIfSandboxed` (default `true` — sandboxed commands run without
prompting; deny/ask rules still bind), `failIfUnavailable`, `allowUnsandboxedCommands`,
`excludedCommands`, `network.{allowedDomains, deniedDomains, strictAllowlist, allowManagedDomainsOnly, httpProxyPort, …}`,
`filesystem.{allowWrite, denyWrite, denyRead, allowRead, allowManagedReadPathsOnly, disabled}`,
`credentials.{files, envVars}` (deny/mask), `enableWeakerNestedSandbox`, `bwrapPath`, `socatPath`.

### Linux runtime requirements

([sandboxing — Set up Linux and WSL2](https://code.claude.com/docs/en/sandboxing#set-up-linux-and-wsl2)):

- **`bubblewrap`** ("the unprivileged sandboxing tool that enforces filesystem isolation") and
  **`socat`** ("the relay used to route network traffic through the sandbox proxy") must be
  installed. `ripgrep` is bundled with the native CLI binary. The **seccomp filter is optional**
  (adds Unix-domain-socket blocking): `npm install -g @anthropic-ai/sandbox-runtime`.
- **Unprivileged user namespaces** must be available to `bwrap`. The docs call out Ubuntu 24.04+'s
  AppArmor restriction (`kernel.apparmor_restrict_unprivileged_userns=1`) needing a `bwrap`
  userns profile, and describe `enableWeakerNestedSandbox` as the fallback for "Docker
  environments without privileged namespaces, or on Linux hosts where unprivileged user
  namespaces are disabled by sysctl" — a mode that "considerably weakens security" (bind-mounts
  the container's `/proc` instead of a fresh one). Whether the Lambda MicroVM guest kernel offers
  unprivileged userns is **probed by ticket [#646](https://github.com/X-GPT/mymemo-agent/issues/646)**,
  not settled here.

### What it enforces

([sandboxing — How sandboxing works](https://code.claude.com/docs/en/sandboxing#how-sandboxing-works)):

- **Filesystem**: writes confined to cwd + `additionalDirectories` + the session temp dir; reads
  default to **the entire computer** minus denied paths — "this default still allows reading
  credential files such as `~/.aws/credentials`", so `denyRead`/`credentials` entries are on the
  deployer. `Edit` allow rules and `Read`/`Edit` deny rules merge into the sandbox boundary.
- **Protected paths**: even inside writable directories, the sandbox denies writes to the files
  Claude Code loads config/code from — `.claude` settings files, `.claude/{skills,agents,commands,hooks}`,
  `.mcp.json`, shell startup files, `.git/hooks` + `.git/config`, and most of `~/.claude` plus
  `~/.claude.json` and `.credentials.json` — with **no exemption possible** ("an `allowWrite`
  entry or an `Edit` allow rule that covers the path doesn't lift the protection")
  ([sandboxing — Protected paths](https://code.claude.com/docs/en/sandboxing#protected-paths)).
  This is a whole second, OS-level cover on #634's config-attack class for anything running under
  Bash. (It does not cover the Read/Write/Edit tools, which bypass the sandbox — hence the
  permission denies remain necessary.)
- **Network**: a proxy outside the sandbox; **no domains pre-allowed by default**, per-domain
  prompting (useless headless), `allowedDomains` to pre-allow; `strictAllowlist: true` makes the
  runtime "deterministically den[y] hosts not in allowedDomains instead of prompting"
  (sdk.d.ts L7416); `allowManagedDomainsOnly` (managed settings) locks the list to managed
  entries. The proxy does not terminate TLS by default; the docs explicitly warn that broad
  domains permit domain-fronting-style exfiltration
  ([sandboxing — Security limitations](https://code.claude.com/docs/en/sandboxing#security-limitations)).
  In the MicroVM this is a second layer under the VM's own egress firewall.

### Fail-open or fail-closed?

**The settings-file path fails open by default; the SDK option path fails closed by default when
it enables the sandbox.** Settings key: "Exit with an error at startup if sandbox.enabled is true
but the sandbox cannot start … **When false (default), a warning is shown and commands run
unsandboxed**" (sdk.d.ts L7401; same statement in the
[sandboxing Warning](https://code.claude.com/docs/en/sandboxing#get-started)). SDK option: "When
`enabled: true` is passed via this option, **`failIfUnavailable` defaults to `true`** — … `query()`
will emit an error result and exit rather than silently running commands unsandboxed"
(sdk.d.ts L1976–1980). Set `failIfUnavailable: true` **explicitly in both places** so the
behavior never depends on which tier won, and set `allowUnsandboxedCommands: false` so the model
cannot route around a sandbox denial.

## 5. `canUseTool`

Signature (sdk.d.ts L209–269):

```ts
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    suggestions?: PermissionUpdate[];
    blockedPath?: string;        // path that triggered the request, e.g. outside allowed dirs
    decisionReason?: string;
    title?: string; displayName?: string; description?: string;
    toolUseID: string; agentID?: string; requestId: string;
    // + askRule metadata
  },
) => Promise<PermissionResult | null>; // null ONLY after out-of-band response; else fail-closed

type PermissionResult =
  | { behavior: 'allow'; updatedInput?: …; updatedPermissions?: PermissionUpdate[]; … }
  | { behavior: 'deny'; message: string; interrupt?: boolean; … };
```

- **It fires last**, step 6 of the evaluation order — only for calls no earlier step resolved.
  "**Auto-approved tools never reach `canUseTool`.** A tool call approved at any earlier step, by
  `acceptEdits` or `bypassPermissions`, or by an allow rule, skips your `canUseTool` callback, so
  permission checks you put there are silently bypassed for that tool"
  ([agent-sdk/permissions](https://code.claude.com/docs/en/agent-sdk/permissions), Warning). In
  `dontAsk` mode it is **never called** (unresolved → deny).
- **As a second-layer path check it is therefore conditional**: it sees a call only if no allow
  rule matched it. With the scoped-allow bundle below it would see exactly the out-of-cwd file
  calls (and could deny with a message) — but `dontAsk` already denies those without code. "For
  checks that must run on every tool call, use a `PreToolUse` hook: hooks run before every other
  step, and a hook deny applies even in `bypassPermissions` mode" (same Warning). MyMemo's
  current allow-all `canUseTool` in the bridge adds nothing under this bundle; drop it or keep it
  only for audit logging in `default` mode.

## 6. Hooks, `disableAllHooks`, and the config load routes — #634 re-checked on 0.3.251

#634 measured four executable-config routes on 0.3.213, all reachable by a prompt-injected
`Write`: settings `hooks`, `apiKeyHelper`, `.mcp.json` stdio spawn, and `~/.claude.json`
`mcpServers` — and that a `permissions.deny` on the config **paths** in the policy tier closed all
four. **The mechanism holds on 0.3.251**; every load route is still documented, and the same
deny-by-path logic (deny rules outrank everything, managed tier outranks all files, policy tier
read under `settingSources: []`) is unchanged (citations in §2–§3). What 0.3.251 changes is that
three of the four routes can now be closed **upstream of the write**:

- Routes 1–2 (settings `hooks`, `apiKeyHelper`, plus `statusLine`, `awsAuthRefresh`,
  `awsCredentialExport`, `processWrapper`, `proxyAuthHelper`, `enabledPlugins`,
  `extraKnownMarketplaces`, skills/agents dirs, …): **never read at all under
  `settingSources: []`** — MyMemo owns the SDK call now, which the map-#631 bridge did not.
- Route 3 (`.mcp.json`) and route 4 (`~/.claude.json` `mcpServers`): `strictMcpConfig: true`
  ("Only use MCP servers passed via the `mcpServers` option …, ignoring all other MCP
  configurations: project `.mcp.json`, user settings, plugins, and on-disk agent frontmatter",
  sdk.d.ts L2100–2106). `~/.claude.json` itself is still always read (§1) — keep its path deny.
- `disableAllHooks` (settings key, "Disable all hooks and statusLine execution", sdk.d.ts L6031)
  remains honored from the policy tier, but #634 already showed it is **not sufficient** (misses
  `apiKeyHelper` and MCP spawns), and it is **not needed** under `settingSources: []` — no
  filesystem hook source is read. Do not set it blindly: MyMemo passes **programmatic** SDK hooks
  (PostCompact), and whether the flag also suppresses SDK callback hooks is not documented —
  verify before ever enabling it.

**New on 0.3.251 needing their own line of defense** (all covered by the bundle):

| Surface | Route | Closed by |
| --- | --- | --- |
| `managed-settings.d/*.json` drop-ins + `managed-mcp.json` | additive policy/MCP in `/etc/claude-code` | root-owned directory (+ existing `//etc/claude-code/**` deny) |
| `policyHelper` (managed-only key) | arbitrary executable run at startup | only settable in the root-owned file we author |
| Hook types `"http"`, `"prompt"`, `"mcp_tool"`, `"agent"` | hooks beyond shell commands | same `hooks` key — unreadable under `settingSources: []` + path denies |
| Skills / plugins / marketplaces | file-based execution & context | discovery is settingSources-gated; `skills` option omitted loads nothing when no source is read; managed locks `strictPluginOnlyCustomization`, `disableSideloadFlags`, `strictKnownMarketplaces` exist if wanted |
| Auto memory `~/.claude/projects/<p>/memory/` | prompt-level persistence across sessions | `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` + `~/.claude/**` deny blocks the model writing it |
| `sandbox.bwrapPath` / `sandbox.socatPath` / `sandbox.ripgrep` | binary-substitution | managed-only, cross-admin-source keys — not plantable from user/project tiers ([managed-settings](https://code.claude.com/docs/en/managed-settings#keys-read-from-every-admin-source)) |
| `toolAliases` (SDK option, redirects built-in names to MCP tools) | SDK-side only | not a settings key; unreachable from files |
| Sandbox protected paths | Bash writing config | native, unexemptable sandbox layer (§4) |

One interlock to know before reaching for more locks: `allowManagedPermissionRulesOnly` makes
Claude Code ignore allow rules "from user, project, and local files and from `--allowedTools`"
([managed-settings](https://code.claude.com/docs/en/managed-settings)) — i.e. it would strip the
SDK-passed scoped allows below. Don't set it, or move the allow rules into the managed file.

## Recommended bundle

### `query()` options (chat-api / worker side)

```ts
import { query } from '@anthropic-ai/claude-agent-sdk'; // pin 0.3.251 exact

const stream = query({
  prompt,
  options: {
    cwd: WORKDIR,                          // fixed per Conversation
    settingSources: [],                    // no user/project/local settings, hooks, skills, CLAUDE.md
    strictMcpConfig: true,                 // only mcpServers passed here; ignores .mcp.json / ~/.claude.json / plugins
    permissionMode: 'dontAsk',             // unresolved calls are denied; canUseTool never fires

    // File tools confined to cwd: scoped allows, never bare 'Read'/'Edit'.
    // Read(./**) also best-effort covers Grep/Glob; Edit(./**) covers Write and NotebookEdit.
    allowedTools: ['Read(./**)', 'Edit(./**)', 'Grep', 'Glob', 'Bash'],
    //             ^ drop bare Grep/Glob/Bash entries if out-of-cwd searches must hard-deny
    //               rather than rely on read-only-in-cwd defaults; sandboxed Bash is
    //               auto-allowed by autoAllowBashIfSandboxed regardless of allow rules.
    disallowedTools: ['WebFetch', 'WebSearch', 'Agent', 'TodoWrite'], // whatever the surface excludes

    sandbox: {
      enabled: true,
      failIfUnavailable: true,             // explicit: never silently run unsandboxed
      allowUnsandboxedCommands: false,     // dangerouslyDisableSandbox is ignored
      autoAllowBashIfSandboxed: true,
      network: {
        allowedDomains: [/* e.g. 'registry.npmjs.org' */],
        strictAllowlist: true,             // deterministic deny, no prompting
      },
      // filesystem: writes already confined to cwd+tmp; add denyRead for anything
      // sensitive the image carries, e.g. { denyRead: ['~/'] , allowRead: ['.'] }
    },

    env: {
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      // CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',  // optional: strip provider creds from subprocesses
    },
    // no canUseTool needed under dontAsk; if kept for audit, use permissionMode 'default'
    // and enforce paths there as well — it only sees calls no allow rule resolved.
  },
});
```

### `/etc/claude-code/managed-settings.json` (baked into the image)

Belt-and-braces under the SDK options above; survives any future drift in how the SDK is invoked,
including a compromised or misconfigured caller, because the policy tier is read even under
`settingSources: []` and outranks every other tier. Path denies are #634's set with `$HOME`
resolved at image build (do not hardcode a home dir the image doesn't use):

```json
{
  "permissions": {
    "deny": [
      "Read(~/.claude/.credentials.json)",
      "Write(~/.claude/**)",      "Edit(~/.claude/**)",
      "Write(~/.claude.json)",    "Edit(~/.claude.json)",
      "Write(~/.claude.json.backup)", "Edit(~/.claude.json.backup)",
      "Write(.claude/**)",        "Edit(.claude/**)",
      "Write(.mcp.json)",         "Edit(.mcp.json)",
      "Write(//etc/claude-code/**)", "Edit(//etc/claude-code/**)"
    ],
    "disableBypassPermissionsMode": "disable"
  },
  "allowManagedMcpServersOnly": true,
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "allowUnsandboxedCommands": false
  }
}
```

Notes: `~/` in managed-file rules resolves against the agent user's home; relative rules
(`.claude/**`, `.mcp.json`) anchor at the session cwd and, as deny rules, match at any depth —
which is what closes nested-checkout copies. `Read` on the settings files is deliberately not
denied (#634: only mutation matters; the CLI itself must read them; deny `.credentials.json` read
only). `allowManagedMcpServersOnly: true` with no `allowedMcpServers` = empty MCP allowlist at the
policy tier, mirroring `strictMcpConfig` for non-SDK invocations. Do **not** add
`allowManagedPermissionRulesOnly` (it would strip the SDK's scoped allows) or `disableAllHooks`
(unverified against MyMemo's programmatic hooks; unnecessary under `settingSources: []`).

### Env vars

| Var | Value | Why |
| --- | --- | --- |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | `1` | auto memory loads regardless of `settingSources` |
| `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` | `1` (optional) | strips Anthropic/cloud creds from all subprocesses; also pins `sandbox.filesystem.disabled` on |
| `CLAUDE_CONFIG_DIR` | leave unset | relocating `~/.claude` would silently move the deny anchors |

### Dockerfile notes

```dockerfile
# Sandbox runtime deps (Linux): bubblewrap enforces filesystem isolation, socat relays the proxy
RUN apt-get update && apt-get install -y bubblewrap socat ripgrep \
 && npm install -g @anthropic-ai/sandbox-runtime   # optional seccomp filter (Unix-socket blocking)

# Managed policy tier: root-owned, non-root agent cannot replace it (moots #634's timing race)
COPY --chown=root:root --chmod=0644 managed-settings.json /etc/claude-code/managed-settings.json
RUN chown root:root /etc/claude-code && chmod 0755 /etc/claude-code
# Never create /etc/claude-code/managed-settings.d writable by the agent user — drop-ins merge in.

USER agent   # non-root; ~/.claude stays agent-owned (the CLI writes transcripts there)
```

Guest-kernel prerequisite: `bwrap` needs unprivileged user namespaces (check
`kernel.apparmor_restrict_unprivileged_userns` where AppArmor is present); if the Lambda MicroVM
guest cannot provide them, the documented fallback `enableWeakerNestedSandbox` "considerably
weakens security" and should trigger a redesign discussion rather than be enabled silently —
**that availability probe is [#646](https://github.com/X-GPT/mymemo-agent/issues/646)**.

## Deltas vs #634 worth carrying forward

1. **Ownership beats timing.** #634's per-turn `onSession` re-write was compensating for a
   same-uid `/etc`; a root-owned image file retires that machinery and its fail-the-turn rule.
2. **`settingSources: []` is now reachable** (MyMemo owns the `query()` call on map #644's
   architecture) and closes routes 1–2 at the source; #634's "not a superset" verdict was about
   the bridge it couldn't configure. The path denies stay as the second layer, and `~/.claude.json`
   still needs them.
3. **The Bash sandbox brings its own config-file protection** (Protected paths, unexemptable) —
   on 0.3.213 this surface wasn't in play because Bash was disallowed outright.
4. **Fail-open default on the settings path**: `sandbox.enabled: true` alone in a settings file
   degrades to unsandboxed execution with a warning when bwrap/userns is missing. `failIfUnavailable:
   true` is the single most load-bearing key in the sandbox bundle.
5. **A bare `Read` allow defeats the cwd boundary.** Any future "just allow the file tools" change
   must keep the `(./**)`-scoped form.

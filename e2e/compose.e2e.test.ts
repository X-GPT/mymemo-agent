/**
 * Docker-compose end-to-end test (MYM-31 harness + MYM-11 search_documents).
 *
 * Exercises the full product path with the E2B sandbox replaced by the local
 * `sandbox` container: chat-api → sandbox-daemon → agent → gateway → postgres.
 * It proves two things over a real stack:
 *
 *   1. Creating a conversation (POST /v1/conversations) then appending a
 *      user.message event (POST /v1/conversations/:id/events) streams the target
 *      SSE vocabulary (conversation_id, run_id, sandbox_id, text_delta…, done)
 *      and no error — the docker path stands in for E2B end to end.
 *   2. The agent's in-process `search_documents` MCP tool actually hydrated a
 *      seeded document: after the turn, the conversation's docs manifest inside
 *      the sandbox container holds an entry for one of the seeded documents,
 *      with a localPath + source + the turn's runId. That can only happen if
 *      search → gateway → postgres → fetch → write-to-disk → manifest all worked.
 *
 * REAL LLM CALLS: the gateway proxies to the configured provider, so this test
 * makes billable calls and depends on a capable model choosing to call
 * search_documents. It is therefore OPT-IN and never runs in the normal unit
 * suite. Enable with:
 *
 *   RUN_COMPOSE_E2E=1 bun test e2e/compose.e2e.test.ts
 *
 * Prerequisites (see README.md "Local end-to-end harness"):
 *   - The stack is up: `docker compose up --build` from the repo root, with the
 *     three apps/<svc>/.env files filled in (gateway needs a real
 *     ANTHROPIC_API_KEY). Or set COMPOSE_E2E_AUTOSTART=1 to have this test run
 *     `docker compose up -d --wait --build` itself (and tear it down after).
 *
 * Overridable knobs:
 *   COMPOSE_CHAT_URL   base URL of chat-api          (default http://localhost:3000)
 *   COMPOSE_E2E_AUTOSTART=1  bring the stack up/down within the test
 *   COMPOSE_E2E_TIMEOUT_MS   per-turn ceiling        (default 120000)
 */

import {
	afterAll,
	beforeAll,
	describe,
	expect,
	it,
	setDefaultTimeout,
} from "bun:test";
import { resolve } from "node:path";

const RUN = process.env.RUN_COMPOSE_E2E === "1";
const CHAT_URL = process.env.COMPOSE_CHAT_URL ?? "http://localhost:3000";
const AUTOSTART = process.env.COMPOSE_E2E_AUTOSTART === "1";
// `Number(undefined)` is NaN and `Number("0")` is 0 — both must fall back to the
// default rather than become a 0/NaN timeout that aborts every turn instantly.
const rawTurnTimeout = Number(process.env.COMPOSE_E2E_TIMEOUT_MS);
const TURN_TIMEOUT_MS =
	Number.isFinite(rawTurnTimeout) && rawTurnTimeout > 0
		? rawTurnTimeout
		: 120_000;

// bun:test hooks take no per-call timeout argument, and bringing the stack up
// (optionally with `--build`) can take minutes. Raise the file-wide default so
// the beforeAll bring-up + the long turn don't trip the 5s default. Only set it
// when the suite will actually run.
if (RUN) setDefaultTimeout(660_000);

// e2e/ -> repo root (where compose.yaml lives).
const REPO_ROOT = resolve(import.meta.dir, "..");

// The seeded member + documents (apps/gateway/db/init.sql). The X-Member-Code
// header maps to the KB workspace, so document search resolves against these.
const MEMBER_CODE = "demo-member";
const PARTNER_CODE = "demo-partner";
const SEEDED_DOCUMENT_IDS = ["doc-ml-intro", "doc-mymemo-overview"];

interface SSEFrame {
	event: string;
	data: string;
}

/** Parse an SSE body into {event, data} frames (mirrors chat.route.test.ts). */
function parseSSE(raw: string): SSEFrame[] {
	const frames: SSEFrame[] = [];
	for (const block of raw.split("\n\n")) {
		let event = "";
		let data = "";
		for (const line of block.split("\n")) {
			if (line.startsWith("event:")) event = line.slice("event:".length).trim();
			else if (line.startsWith("data:"))
				data = line.slice("data:".length).trim();
		}
		if (event) frames.push({ event, data });
	}
	return frames;
}

/** Run a docker compose subcommand from the repo root; return {code, stdout, stderr}. */
async function compose(
	args: string[],
	timeoutMs = 180_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(["docker", "compose", ...args], {
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	const killer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { code, stdout, stderr };
	} finally {
		clearTimeout(killer);
	}
}

/** True once chat-api answers /health (the stack is reachable). */
async function chatApiHealthy(): Promise<boolean> {
	try {
		const res = await fetch(`${CHAT_URL}/health`, {
			signal: AbortSignal.timeout(2_000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

async function waitForHealthy(timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await chatApiHealthy()) return true;
		await Bun.sleep(2_000);
	}
	return false;
}

/**
 * Read the docs manifest for a conversation from inside the sandbox container.
 * Returns null when the file does not exist (agent didn't hydrate anything).
 */
async function readConversationManifest(
	conversationId: string,
): Promise<{ version: number; documents: unknown[] } | null> {
	const path = `/workspace/conversations/${conversationId}/docs/manifest.json`;
	const { code, stdout } = await compose(
		["exec", "-T", "sandbox", "sh", "-lc", `cat ${path} 2>/dev/null || true`],
		15_000,
	);
	if (code !== 0 || stdout.trim() === "") return null;
	return JSON.parse(stdout) as { version: number; documents: unknown[] };
}

/**
 * Read a hydrated document's content from inside the sandbox container, by its
 * manifest-relative `localPath`. Returns null when the file is absent — so the
 * test can prove the blob was actually written, not just manifested.
 */
async function readHydratedDoc(
	conversationId: string,
	localPath: string,
): Promise<string | null> {
	const path = `/workspace/conversations/${conversationId}/docs/${localPath}`;
	const { code, stdout } = await compose(
		["exec", "-T", "sandbox", "sh", "-lc", `cat ${path} 2>/dev/null || true`],
		15_000,
	);
	if (code !== 0 || stdout === "") return null;
	return stdout;
}

let startedByTest = false;

describe.skipIf(!RUN)(
	"docker-compose E2E (E2B replaced by the sandbox container)",
	() => {
		beforeAll(async () => {
			if (AUTOSTART && !(await chatApiHealthy())) {
				const { code, stderr } = await compose(
					["up", "-d", "--wait", "--build"],
					600_000,
				);
				if (code !== 0) {
					throw new Error(`docker compose up failed:\n${stderr}`);
				}
				startedByTest = true;
			}

			if (!(await waitForHealthy(60_000))) {
				throw new Error(
					`chat-api is not reachable at ${CHAT_URL}. Start the stack with ` +
						`\`docker compose up --build\` (see README "Local end-to-end harness"), ` +
						`or set COMPOSE_E2E_AUTOSTART=1.`,
				);
			}
		});

		afterAll(async () => {
			// Only tear down what this test started; leave a user-managed stack alone.
			if (startedByTest) await compose(["down"], 120_000);
		});

		it(
			"creates a conversation, streams a turn, and hydrates a seeded document via search_documents",
			async () => {
				// 0. Create the conversation (general scope — no collectionId/summaryId).
				//    The conversation must exist in chat-api's writable DB before the
				//    events turn; this also proves the migrate one-shot provisioned the
				//    `conversations` table.
				const createRes = await fetch(`${CHAT_URL}/v1/conversations`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-member-code": MEMBER_CODE,
						"x-partner-code": PARTNER_CODE,
					},
					body: JSON.stringify({}),
					signal: AbortSignal.timeout(30_000),
				});
				const createBody = await createRes.text();
				expect(
					createRes.status,
					`create conversation failed; body: ${createBody.slice(0, 500)}`,
				).toBe(201);
				const conversationId = JSON.parse(createBody).conversationId as string;
				expect(conversationId.length).toBeGreaterThan(0);

				// 1. Append a user.message event and stream the turn.
				const res = await fetch(
					`${CHAT_URL}/v1/conversations/${conversationId}/events`,
					{
						method: "POST",
						headers: {
							"content-type": "application/json",
							"x-member-code": MEMBER_CODE,
							"x-partner-code": PARTNER_CODE,
						},
						// Force the document tool explicitly. The remote-search-by-default
						// agent prompt is MYM-13 (not yet wired), so a soft "find my doc
						// about X" lets the model answer from its own knowledge without ever
						// calling search_documents. Instructing it to call the tool and not
						// answer from memory makes the hydration deterministic here.
						body: JSON.stringify({
							type: "user.message",
							text:
								"Use the search_documents tool to find my MyMemo document about " +
								"machine learning, then tell me its title. You must call " +
								"search_documents; do not answer from your own knowledge.",
						}),
						signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
					},
				);

				// Read the body once, up front: on a non-200 (e.g. the gateway 502s or
				// chat-api 500s) surface it in the failure message instead of a bare
				// "expected 200, got 500" that hides the cause.
				const bodyText = await res.text();
				expect(
					res.status,
					`unexpected status; body: ${bodyText.slice(0, 500)}`,
				).toBe(200);

				const frames = parseSSE(bodyText);
				const events = frames.map((f) => f.event).filter((e) => e !== "ping");

				// 2. Protocol: the docker path streams the full target vocabulary and
				//    completes without surfacing an error.
				expect(events).toContain("conversation_id");
				expect(events).toContain("run_id");
				expect(events).toContain("sandbox_id");
				expect(events).toContain("text_delta");
				expect(events).toContain("done");
				expect(events).not.toContain("error");

				// The streamed conversation_id echoes the one we created.
				const echoedConversationId = JSON.parse(
					frames.find((f) => f.event === "conversation_id")!.data,
				).conversationId as string;
				expect(echoedConversationId).toBe(conversationId);
				const runId = JSON.parse(frames.find((f) => f.event === "run_id")!.data)
					.runId as string;

				// 2. Hydration: search_documents wrote a seeded document into this
				//    conversation's docs manifest, attributed to this run.
				const manifest = await readConversationManifest(conversationId);
				expect(
					manifest,
					`no docs manifest for conversation ${conversationId}; the agent did ` +
						`not hydrate any document this turn`,
				).not.toBeNull();
				expect(manifest!.documents.length).toBeGreaterThan(0);

				const entries = manifest!.documents as Array<{
					documentId: string;
					localPath: string;
					source: string;
					runId: string;
				}>;
				expect(
					entries.some((e) => SEEDED_DOCUMENT_IDS.includes(e.documentId)),
				).toBe(true);
				const hydrated = entries.find((e) =>
					SEEDED_DOCUMENT_IDS.includes(e.documentId),
				)!;
				expect(hydrated.localPath.length).toBeGreaterThan(0);
				expect(hydrated.source.length).toBeGreaterThan(0);
				expect(hydrated.runId).toBe(runId);

				// 3. The manifest entry must be backed by a real, non-empty file on
				//    disk — not just a manifest row — so the agent's Read would work.
				const docContent = await readHydratedDoc(
					conversationId,
					hydrated.localPath,
				);
				expect(
					docContent,
					`manifest references ${hydrated.localPath} but no file was hydrated there`,
				).not.toBeNull();
				expect(docContent!.trim().length).toBeGreaterThan(0);
			},
			TURN_TIMEOUT_MS + 30_000,
		);
	},
);

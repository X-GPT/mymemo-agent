// PROTOTYPE — throwaway stub of the Lambda front (#726). Implements the #723
// client contract verbatim with scripted UIMessage chunks; no Runtime, no
// DynamoDB. `bun run server.ts` → http://localhost:3010
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

type Scope = { kind: "general" | "collection" | "document"; collectionId?: string; summaryId?: string };
type Artifact = { artifactId: string; path: string; sizeBytes: number; contentType: string; createdAt: string; updatedAt: string; exportedAt: number; body: string };
type Turn = {
	seq: number; turnId: string; requestId: string; text: string; assistantMessageId: string;
	status: "processing" | "done" | "error" | "abandoned"; errorCode?: string;
	startedAt: string; endedAt?: string; steps: unknown[][]; artifactsPart?: unknown;
};
type Conv = {
	conversationId: string; userId: string; partnerCode: string; teamCode?: string; scope: Scope;
	title: string | null; createdAt: string; lastActivityAt: string; archivedAt: string | null; deletedAt?: string;
	processing?: { turnId: string; until: number }; turnCount: number; turns: Turn[];
	requests: Map<string, { turnId: string; hash: string }>; artifacts: Map<string, Artifact>;
};

const convs = new Map<string, Conv>();
const BUDGET_MS = 10 * 60_000, GRACE_MS = 2 * 60_000, EXPORT_LAG_MS = 5_000;
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hash = (s: string) => Bun.hash(s).toString(16);
const err = (c: any, status: number, error: string, extra: Record<string, unknown> = {}) => c.json({ error, ...extra }, status);
const summary = (v: Conv) => ({ conversationId: v.conversationId, title: v.title, scope: v.scope.kind, createdAt: v.createdAt, lastActivityAt: v.lastActivityAt, archivedAt: v.archivedAt });
// v1 field names kept (sizeBytes, createdAt): mymemo-web's parser requires them — contract revision for #723
const artifactView = (a: Artifact) => ({ artifactId: a.artifactId, path: a.path, sizeBytes: a.sizeBytes, contentType: a.contentType, createdAt: a.createdAt, updatedAt: a.updatedAt });

const app = new Hono();

// identity — the Lambda trusts mymemo-service's headers
app.use("/v1/*", async (c, next) => {
	const member = c.req.header("x-member-code"), partner = c.req.header("x-partner-code");
	if (!member || !partner) return err(c, 401, "unauthenticated");
	c.set("identity" as never, { member, partner, team: c.req.header("x-team-code") } as never);
	await next();
});
const identity = (c: any) => c.get("identity") as { member: string; partner: string; team?: string };
const owned = (c: any): Conv | null => {
	const v = convs.get(c.req.param("id"));
	return v && !v.deletedAt && v.userId === identity(c).member ? v : null;
};

app.post("/v1/conversations", async (c) => {
	const body = await c.req.json().catch(() => null);
	if (!body || typeof body !== "object" || Object.keys(body).some((k) => !["collectionId", "summaryId"].includes(k))) return err(c, 400, "invalid_body");
	const scope: Scope = body.summaryId ? { kind: "document", summaryId: body.summaryId } : body.collectionId ? { kind: "collection", collectionId: body.collectionId } : { kind: "general" };
	const { member, partner, team } = identity(c);
	const v: Conv = { conversationId: id(), userId: member, partnerCode: partner, teamCode: team, scope, title: null, createdAt: now(), lastActivityAt: now(), archivedAt: null, turnCount: 0, turns: [], requests: new Map(), artifacts: new Map() };
	convs.set(v.conversationId, v);
	return c.json(summary(v), 201);
});

app.get("/v1/conversations", (c) => {
	const archived = c.req.query("archived") === "true", search = (c.req.query("search") ?? "").toLowerCase();
	const limit = Math.min(Number(c.req.query("limit") ?? 20), 100), cursor = c.req.query("cursor");
	let list = [...convs.values()].filter((v) => !v.deletedAt && v.userId === identity(c).member && Boolean(v.archivedAt) === archived && (!search || (v.title ?? "").toLowerCase().includes(search)))
		.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
	if (cursor) list = list.filter((v) => v.lastActivityAt < cursor);
	const page = list.slice(0, limit);
	return c.json({ conversations: page.map(summary), nextCursor: list.length > limit ? page.at(-1)!.lastActivityAt : null });
});

app.patch("/v1/conversations/:id", async (c) => {
	const v = owned(c); if (!v) return err(c, 404, "not_found");
	const body = await c.req.json().catch(() => null);
	if (body && typeof body.title === "string" && Object.keys(body).length === 1) v.title = body.title.trim().slice(0, 120);
	else if (body && typeof body.archived === "boolean" && Object.keys(body).length === 1) v.archivedAt = body.archived ? (v.archivedAt ?? now()) : null;
	else return err(c, 400, "invalid_body");
	return c.json(summary(v));
});

app.delete("/v1/conversations/:id", (c) => {
	const v = owned(c); if (!v) return err(c, 404, "not_found");
	if (v.processing && v.processing.until > Date.now()) return err(c, 409, "processing", { turnId: v.processing.turnId });
	v.deletedAt = now(); // tombstone; cleanup would be the sweep's
	return c.body(null, 204);
});

app.get("/v1/conversations/:id/messages", (c) => {
	const v = owned(c); if (!v) return err(c, 404, "not_found");
	const limit = Math.min(Number(c.req.query("limit") ?? 20), 100), cursor = Number(c.req.query("cursor") ?? Infinity);
	const turns = v.turns.filter((t) => t.seq < cursor).sort((a, b) => b.seq - a.seq);
	const page = turns.slice(0, limit);
	const messages = page.flatMap((t) => [
		{ id: `u_${t.turnId}`, role: "user", parts: [{ type: "text", text: t.text }], metadata: { turnId: t.turnId, requestId: t.requestId } },
		{ id: t.assistantMessageId, role: "assistant", parts: [...t.steps.flat(), ...(t.artifactsPart ? [t.artifactsPart] : [])], metadata: { turnId: t.turnId, requestId: t.requestId, status: t.status, errorCode: t.errorCode, startedAt: t.startedAt, endedAt: t.endedAt } },
	]);
	return c.json({ messages, nextCursor: turns.length > limit ? String(page.at(-1)!.seq) : null });
});

app.get("/v1/conversations/:id/artifacts", (c) => {
	const v = owned(c); if (!v) return err(c, 404, "not_found");
	return c.json({ artifacts: [...v.artifacts.values()].sort((a, b) => a.path.localeCompare(b.path)).map(artifactView) });
});
app.get("/v1/conversations/:id/artifacts/:artifactId/download-url", (c) => {
	const v = owned(c); if (!v) return err(c, 404, "not_found");
	const a = v.artifacts.get(c.req.param("artifactId")); if (!a) return err(c, 404, "not_found");
	if (a.exportedAt > Date.now()) return err(c, 409, "not_exported_yet"); // S3 Files export lag
	return c.json({ downloadUrl: `http://localhost:3010/files/${v.conversationId}/${a.artifactId}?exp=${Date.now() + 300_000}` });
});
app.get("/files/:cid/:aid", (c) => {
	const a = convs.get(c.req.param("cid"))?.artifacts.get(c.req.param("aid"));
	if (!a || Number(c.req.query("exp")) < Date.now()) return c.text("expired", 403);
	return c.body(a.body, 200, { "content-type": a.contentType, "content-disposition": `attachment; filename="${a.path.split("/").pop()}"` });
});

// ---- send ----
app.post("/v1/conversations/:id/messages", async (c) => {
	const v = owned(c); if (!v) return err(c, 404, "not_found");
	const body = await c.req.json().catch(() => null);
	const text = typeof body?.text === "string" ? body.text : "", requestId = typeof body?.requestId === "string" ? body.requestId : "";
	if (!text.trim() || Buffer.byteLength(text) > 32 * 1024 || !requestId) return err(c, 400, "invalid_body");
	if (v.archivedAt) return err(c, 409, "archived");
	const seen = v.requests.get(requestId);
	if (seen) {
		if (seen.hash !== hash(text)) return err(c, 409, "request_id_conflict");
		return err(c, 409, "duplicate_request", { turnId: seen.turnId, status: v.turns.find((t) => t.turnId === seen.turnId)?.status });
	}
	if (v.processing) {
		if (v.processing.until > Date.now()) return err(c, 409, "processing", { turnId: v.processing.turnId });
		const stale = v.turns.find((t) => t.turnId === v.processing!.turnId)!;
		stale.status = "abandoned"; stale.errorCode = "abandoned"; stale.endedAt = now();
	}
	// the conditional write wins
	const turn: Turn = { seq: ++v.turnCount, turnId: id(), requestId, text, assistantMessageId: id(), status: "processing", startedAt: now(), steps: [] };
	v.turns.push(turn); v.requests.set(requestId, { turnId: turn.turnId, hash: hash(text) });
	v.processing = { turnId: turn.turnId, until: Date.now() + BUDGET_MS + GRACE_MS };
	if (!v.title) v.title = text.trim().slice(0, 120);
	v.lastActivityAt = now();

	// The "Runtime": runs to completion even if the client goes away.
	const chunks = runTurn(v, turn);
	c.header("x-vercel-ai-ui-message-stream", "v1");
	c.header("x-accel-buffering", "no");
	return streamSSE(c, async (stream) => {
		for await (const chunk of chunks) await stream.writeSSE({ data: JSON.stringify(chunk) });
		await stream.writeSSE({ data: "[DONE]" });
	}, async () => { /* client gone: keep draining so the Turn finishes */ for await (const _ of chunks) { /* noop */ } });
});

async function* runTurn(v: Conv, t: Turn): AsyncGenerator<unknown> {
	const slow = /slow/i.test(t.text), fail = /fail/i.test(t.text);
	const tick = slow ? 700 : 120;
	let step: unknown[] = [];
	const commit = () => { t.steps[t.steps.length - 1] = [...step]; };
	yield { type: "start", messageId: t.assistantMessageId, messageMetadata: { turnId: t.turnId, requestId: t.requestId, status: "processing", startedAt: t.startedAt } };

	// step 1: text + Read tool
	t.steps.push([]); step = [{ type: "step-start" }];
	yield { type: "start-step" };
	const tid1 = `text_${id()}`; yield { type: "text-start", id: tid1 };
	let acc = "";
	for (const w of "Let me look at the workspace first. ".split(" ")) { acc += w + " "; yield { type: "text-delta", id: tid1, delta: w + " " }; await sleep(tick); }
	yield { type: "text-end", id: tid1 }; step.push({ type: "text", text: acc, state: "done" });
	const call1 = `call_${id()}`;
	yield { type: "tool-input-start", toolCallId: call1, toolName: "Read" };
	yield { type: "tool-input-available", toolCallId: call1, toolName: "Read", input: { file_path: "notes/plan.md" } };
	await sleep(tick * 4);
	const out1 = { value: "# Plan\n\n- ship the prototype\n- measure\n", truncated: false, totalBytes: 38 };
	yield { type: "tool-output-available", toolCallId: call1, output: out1 };
	step.push({ type: "tool-Read", toolCallId: call1, state: "output-available", input: { file_path: "notes/plan.md" }, output: out1 });
	commit(); yield { type: "finish-step" };

	if (fail) {
		t.status = "error"; t.errorCode = "internal_error"; t.endedAt = now(); v.processing = undefined;
		yield { type: "message-metadata", messageMetadata: { status: "error", errorCode: "internal_error", endedAt: t.endedAt } };
		yield { type: "error", errorText: "internal_error" };
		return;
	}

	// step 2: catalog part + Write artifact + text
	t.steps.push([]); step = [{ type: "step-start" }];
	yield { type: "start-step" };
	const ui = { type: "data-generative-ui", id: `gui_${id()}`, data: { version: 1, payload: { component: "table", props: { title: "Prototype checks", columns: [{ key: "check", label: "Check" }, { key: "result", label: "Result" }], rows: [{ check: "stream", result: "pass" }, { check: "catalog", result: "rendering now" }, { check: "artifacts", result: "next" }] } } } };
	step.push(ui); commit(); // validate → persist → emit
	yield ui;
	await sleep(tick * 3);
	const call2 = `call_${id()}`, content = `# Report for Turn ${t.seq}\n\nGenerated at ${now()}\n`;
	yield { type: "tool-input-start", toolCallId: call2, toolName: "Write" };
	yield { type: "tool-input-available", toolCallId: call2, toolName: "Write", input: { file_path: "artifacts/report.md", content } };
	await sleep(tick * 4);
	const out2 = { value: "ok", truncated: false, totalBytes: 2 };
	yield { type: "tool-output-available", toolCallId: call2, output: out2 };
	step.push({ type: "tool-Write", toolCallId: call2, state: "output-available", input: { file_path: "artifacts/report.md", content }, output: out2 });
	const tid2 = `text_${id()}`; yield { type: "text-start", id: tid2 };
	acc = "";
	for (const w of `Done. I wrote artifacts/report.md and summarised the checks above (turn ${t.seq}).`.split(" ")) { acc += w + " "; yield { type: "text-delta", id: tid2, delta: w + " " }; await sleep(tick); }
	yield { type: "text-end", id: tid2 }; step.push({ type: "text", text: acc, state: "done" });
	commit(); yield { type: "finish-step" };

	// Turn end: artifacts from the mount listing
	const aid = hash("report.md"), existed = v.artifacts.get(aid);
	const art: Artifact = { artifactId: aid, path: "report.md", sizeBytes: Buffer.byteLength(content), contentType: "text/markdown", createdAt: existed?.createdAt ?? now(), updatedAt: now(), exportedAt: Date.now() + EXPORT_LAG_MS, body: content };
	v.artifacts.set(aid, art);
	t.artifactsPart = { type: "data-artifacts", id: t.turnId, data: { artifacts: [artifactView(art)], removed: existed ? [] : [] } };
	yield t.artifactsPart;
	t.status = "done"; t.endedAt = now(); v.processing = undefined;
	yield { type: "message-metadata", messageMetadata: { status: "done", endedAt: t.endedAt } };
	yield { type: "finish" };
}

app.onError((e, c) => { console.error(e); return c.json({ error: "internal_error" }, 500); });
console.log("stub front on http://localhost:3010");
export default { port: 3010, fetch: app.fetch, idleTimeout: 255 };

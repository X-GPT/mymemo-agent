// #730 item 3 — does `Options.sessionId` (pre-minted) + `sessionStore` on a fresh session,
// then `resume: <same id>` through the store on a FRESH CLAUDE_CONFIG_DIR, work on the pinned
// SDK 0.3.251? Runs against a fake Anthropic Messages server; no model key, no AWS.
// Run: bun run sdk-session-probe.ts | tee results/sdk-session-probe.log
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${String(Date.now() - t0).padStart(6)}ms]`, ...a);
setTimeout(() => { log("WALLCLOCK CAP 240s HIT"); process.exit(124); }, 240_000);
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const sdkPath = Bun.resolveSync("@anthropic-ai/claude-agent-sdk", import.meta.dir);
log(`sdk resolved to ${sdkPath} version=${JSON.parse(readFileSync(join(dirname(sdkPath), "package.json"), "utf8")).version}`);

// ---- fake Anthropic Messages server ----
let modelCalls = 0; const msgLens: number[] = [];
const server = Bun.serve({ port: 0, async fetch(req) {
  const url = new URL(req.url);
  if (req.method !== "POST" || !url.pathname.endsWith("/messages")) return new Response("{}", { status: 404 });
  const body = (await req.json()) as { messages: unknown[] };
  modelCalls++; msgLens.push(body.messages.length);
  log(`FAKE model call #${modelCalls}: messages.length=${body.messages.length}`);
  const stream = new ReadableStream({ async start(c) {
    const ev = (type: string, data: unknown) => c.enqueue(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    ev("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "fake", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    for (const w of ["Hello", " from", " fake", " model."]) { ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: w } }); await Bun.sleep(30); }
    ev("content_block_stop", { type: "content_block_stop", index: 0 });
    ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
    ev("message_stop", { type: "message_stop" }); c.close();
  } });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
} });
const base = `http://127.0.0.1:${server.port}`;

// ---- in-memory SessionStore that logs every call (stands in for the S3 adapter) ----
type Key = { projectKey: string; sessionId: string; subpath?: string };
class MemStore {
  map = new Map<string, Record<string, unknown>[]>(); calls: string[] = [];
  k(key: Key) { return `${key.projectKey}/${key.sessionId}${key.subpath ? "/" + key.subpath : ""}`; }
  async append(key: Key, entries: Record<string, unknown>[]) { const k = this.k(key); this.calls.push(`append ${k} +${entries.length} [${entries.map(e => e.type).join(",")}]`); this.map.set(k, [...(this.map.get(k) ?? []), ...entries]); }
  async load(key: Key) { const k = this.k(key); const v = this.map.get(k) ?? null; this.calls.push(`load ${k} -> ${v ? v.length : "null"}`); return v ? [...v] : null; }
  async listSubkeys(key: { projectKey: string; sessionId: string }) { const p = `${key.projectKey}/${key.sessionId}/`; const r = [...this.map.keys()].filter(x => x.startsWith(p)).map(x => x.slice(p.length)); this.calls.push(`listSubkeys ${p} -> ${JSON.stringify(r)}`); return r; }
  stats() { let n = 0, dup = 0; const seen = new Set<string>(); for (const v of this.map.values()) for (const e of v) { n++; const u = e.uuid as string | undefined; if (u) { if (seen.has(u)) dup++; else seen.add(u); } } return { keys: [...this.map.keys()], entries: n, dupUuids: dup }; }
}

type Res = { init?: string; version?: string; isError?: boolean; threw?: string; result?: string; msgLens: number[]; mirrorErrors: number };
async function run(label: string, opts: Record<string, unknown>, cfg: string, cwd: string): Promise<Res> {
  const env: Record<string, string | undefined> = { ...process.env, ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: "fake-token", CLAUDE_CONFIG_DIR: cfg };
  delete env.ANTHROPIC_API_KEY; delete env.CLAUDE_CODE_PROJECT_DIR_NAME;
  log(`=== ${label} cfg=${cfg} cwd=${cwd} opts=${JSON.stringify(Object.fromEntries(Object.entries(opts).map(([k, v]) => [k, k === "sessionStore" ? "<store>" : v])))}`);
  const r: Res = { msgLens: [], mirrorErrors: 0 }; const before = modelCalls;
  const q = query({ prompt: "Say hi", options: { tools: [], permissionMode: "dontAsk", maxTurns: 1, env, cwd, sessionStoreLoadTimeout: 30_000, ...opts } as never });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const iterate = async () => { for await (const m of q as AsyncIterable<Record<string, unknown>>) {
    const extra: string[] = [];
    if (m.type === "system" && m.subtype === "init") { r.init = m.session_id as string; r.version = (m.claude_code_version ?? m.version) as string | undefined; extra.push(`session_id=${r.init} version=${r.version} cwd=${m.cwd}`); }
    if (m.type === "system" && m.subtype === "mirror_error") { r.mirrorErrors++; extra.push(JSON.stringify(m)); }
    if (m.type === "result") { r.isError = m.is_error as boolean; r.result = JSON.stringify(m.result ?? m.errors ?? ""); extra.push(`subtype=${m.subtype} session_id=${m.session_id} is_error=${r.isError} num_turns=${m.num_turns} result=${r.result.slice(0, 200)}`); }
    log(`ITER ${m.type}${m.subtype ? "/" + m.subtype : ""} ${extra.join(" ")}`);
  } log("ITER end"); };
  try { await Promise.race([iterate(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("per-query 60s timeout")), 60_000); })]); }
  catch (e) { r.threw = (e as Error).message; log(`QUERY THREW: ${r.threw}`); try { await (q as unknown as { close?: () => Promise<void> }).close?.(); } catch {} }
  finally { clearTimeout(timer); }
  r.msgLens = msgLens.slice(before);
  log(`--- ${label}: init=${r.init} isError=${r.isError} threw=${r.threw ?? "no"} modelMsgLens=${JSON.stringify(r.msgLens)} mirrorErrors=${r.mirrorErrors}`);
  return r;
}
const localJsonl = (cfg: string, id: string) => { const d = join(cfg, "projects"); if (!existsSync(d)) return "no projects dir"; const hits = [...new Bun.Glob(`**/${id}.jsonl`).scanSync({ cwd: d })]; return hits.length ? hits.join(",") : "no jsonl"; };

const id = crypto.randomUUID(); const store = new MemStore(); const FIXED_CWD = tmp("cwd-fixed-"); const summary: string[] = [];
log(`sessionId=${id} fixedCwd=${FIXED_CWD}`);

const A = tmp("cfgA-"); const r1 = await run("S1 Turn1 fresh: sessionId + sessionStore", { sessionId: id, sessionStore: store }, A, FIXED_CWD);
log("S1 store", JSON.stringify(store.stats()), "local:", localJsonl(A, id));
summary.push(`S1 ${r1.init === id && !r1.isError && !r1.threw && store.stats().entries > 0 ? "PASS" : "FAIL"} pre-minted id honoured=${r1.init === id} entriesInStore=${store.stats().entries} msgLens=${JSON.stringify(r1.msgLens)}`);

const B = tmp("cfgB-"); const r2 = await run("S2 Turn2: resume via store on FRESH config dir, same cwd", { resume: id, sessionStore: store }, B, FIXED_CWD);
log("S2 store", JSON.stringify(store.stats()), "local:", localJsonl(B, id));
summary.push(`S2 ${r2.init === id && !r2.isError && !r2.threw && (r2.msgLens[0] ?? 0) > (r1.msgLens[0] ?? 0) ? "PASS" : "FAIL"} msgLens=${JSON.stringify(r2.msgLens)} (turn1 ${JSON.stringify(r1.msgLens)}) localCopyAfterRun=${localJsonl(B, id)}`);

const C = tmp("cfgC-"); const r3 = await run("S3 Turn3: resume via store again, fresh config dir", { resume: id, sessionStore: store }, C, FIXED_CWD);
summary.push(`S3 ${r3.init === id && !r3.isError && !r3.threw && (r3.msgLens[0] ?? 0) > (r2.msgLens[0] ?? 0) ? "PASS" : "FAIL"} msgLens=${JSON.stringify(r3.msgLens)} store=${JSON.stringify(store.stats())}`);

const D = tmp("cfgD-"); const r4 = await run("S4 negative: resume via an EMPTY store", { resume: id, sessionStore: new MemStore() }, D, FIXED_CWD);
summary.push(`S4 ${r4.isError || r4.threw ? "PASS(expected failure)" : "FAIL(unexpectedly resumed)"} isError=${r4.isError} threw=${r4.threw ?? "no"} result=${r4.result}`);

const E = tmp("cfgE-"); const r5 = await run("S5 info: resume via store from a DIFFERENT cwd (projectKey changes)", { resume: id, sessionStore: store }, E, tmp("cwd-other-"));
summary.push(`S5 info(different cwd) init=${r5.init} isError=${r5.isError} threw=${r5.threw ?? "no"} msgLens=${JSON.stringify(r5.msgLens)} result=${(r5.result ?? "").slice(0, 120)}`);

const r6 = await run("S6 info: resume WITHOUT a store on cfgB (is the materialised local copy still there?)", { resume: id }, B, FIXED_CWD);
summary.push(`S6 info(no store, cfgB) init=${r6.init} isError=${r6.isError} threw=${r6.threw ?? "no"} msgLens=${JSON.stringify(r6.msgLens)} local=${localJsonl(B, id)}`);

log("STORE CALLS\n  " + store.calls.join("\n  "));
log("SUMMARY\n" + summary.join("\n"));
log(`sdk=${r1.version} totalModelCalls=${modelCalls} mirrorErrorsTotal=${r1.mirrorErrors + r2.mirrorErrors + r3.mirrorErrors}`);
server.stop(true); process.exit(0);

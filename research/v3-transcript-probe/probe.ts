import { query, type SessionStore, type SessionKey, type SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

const SP = '/private/tmp/claude-501/-Users-chengchao-code-mymemo-mymemo-agent/19b5a1fd-ec9b-463c-9f5d-599cb1cad50f/scratchpad/probe';
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${String(Date.now() - t0).padStart(6)}ms]`, ...a);

// ---- fake Anthropic Messages server ----
let modelCalls = 0;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method !== 'POST' || !url.pathname.endsWith('/messages')) {
      log('FAKE non-messages request', req.method, url.pathname);
      return new Response('{}', { status: 404 });
    }
    const body = await req.json() as { messages: unknown[] };
    modelCalls++;
    log(`FAKE model call #${modelCalls}: messages.length=${body.messages.length}`, JSON.stringify(body.messages.map((m: any) => ({ role: m.role, c: typeof m.content === 'string' ? m.content.slice(0, 40) : m.content.map((b: any) => b.type + ':' + (b.text ?? '').slice(0, 30)) }))));
    const words = ['Hello', ' from', ' fake', ' model.'];
    const stream = new ReadableStream({
      async start(c) {
        const ev = (type: string, data: unknown) => c.enqueue(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        ev('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'fake', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
        ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        for (const w of words) { ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: w } }); await Bun.sleep(50); }
        ev('content_block_stop', { type: 'content_block_stop', index: 0 });
        ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } });
        ev('message_stop', { type: 'message_stop' });
        c.close();
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  },
});
const base = `http://127.0.0.1:${server.port}`;

// ---- logging store ----
const mem = new Map<string, SessionStoreEntry[]>();
const k = (key: SessionKey) => `${key.projectKey}|${key.sessionId}|${key.subpath ?? ''}`;
let appendCount = 0;
const appendDelayMs = Number(process.env.PROBE_APPEND_DELAY ?? 0);
const loadMode = process.env.PROBE_LOAD ?? 'mem'; // mem | null | throw
const store: SessionStore = {
  async append(key, entries) {
    appendCount++;
    const n = appendCount;
    log(`STORE append#${n} START key=${JSON.stringify(key)} entries=${entries.length} withUuid=${entries.filter(e => e.uuid).length} types=${JSON.stringify(entries.map(e => e.type))} withSessionIdField=${entries.filter(e => 'sessionId' in e).length}`);
    if (appendDelayMs) await Bun.sleep(appendDelayMs);
    mem.set(k(key), [...(mem.get(k(key)) ?? []), ...entries]);
    log(`STORE append#${n} DONE`);
  },
  async load(key) {
    log(`STORE load key=${JSON.stringify(key)} mode=${loadMode}`);
    if (loadMode === 'throw') throw new Error('probe: load exploded');
    if (loadMode === 'null') return null;
    const v = mem.get(k(key)) ?? null;
    log(`STORE load -> ${v ? v.length + ' entries' : 'null'}`);
    return v;
  },
  async listSubkeys(key) { log(`STORE listSubkeys key=${JSON.stringify(key)}`); return []; },
  async listSessions(projectKey) { log(`STORE listSessions projectKey=${projectKey}`); return [...mem.keys()].filter(x => x.startsWith(projectKey + '|')).map(x => ({ sessionId: x.split('|')[1]!, mtime: Date.now() })); },
};

async function runQuery(label: string, opts: Record<string, unknown>, prompt: string, envExtra: Record<string, string> = {}) {
  const cfg = mkdtempSync(join(SP, 'cfg-'));
  const env = { ...process.env, ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: 'fake-token', CLAUDE_CONFIG_DIR: cfg, ...envExtra };
  delete (env as any).ANTHROPIC_API_KEY;
  log(`=== ${label} cfg=${cfg} env.CLAUDE_CODE_PROJECT_DIR_NAME=${envExtra.CLAUDE_CODE_PROJECT_DIR_NAME}`);
  const q = query({
    prompt,
    options: { tools: [], permissionMode: 'dontAsk', maxTurns: 1, sessionStore: store, env, cwd: SP, ...opts },
  });
  try {
    for await (const m of q as AsyncIterable<any>) {
      const extra: string[] = [];
      if (m.type === 'system' && m.subtype === 'init') extra.push(`session_id=${m.session_id}`);
      if (m.type === 'result') extra.push(`session_id=${m.session_id} is_error=${m.is_error} num_turns=${m.num_turns} result=${JSON.stringify(m.result ?? m.errors ?? '').slice(0, 200)}`);
      if (m.type === 'system' && m.subtype === 'mirror_error') extra.push(JSON.stringify(m));
      if (m.type === 'assistant') extra.push(JSON.stringify(m.message?.content).slice(0, 80));
      log(`ITER ${m.type}${m.subtype ? '/' + m.subtype : ''} ${extra.join(' ')}`);
    }
    log(`ITER end (appends so far: ${appendCount})`);
  } catch (e) {
    log(`QUERY THREW: ${(e as Error).message}`);
  }
  return cfg;
}

const scenario = process.argv[2] ?? 'q1';
const id = crypto.randomUUID();
log(`scenario=${scenario} id=${id} fake=${base}`);

if (scenario === 'q1') {
  await runQuery('q1 fresh sessionId+store', { sessionId: id }, 'Say hi');
  for (const [key, v] of mem) log(`MEM ${key}: ${v.length} entries; distinct types=${JSON.stringify([...new Set(v.map(e => e.type))])}; uuid-less types=${JSON.stringify(v.filter(e => !e.uuid).map(e => e.type))}; sessionId-field=${v.filter(e => 'sessionId' in e).length} session_id-field=${v.filter(e => 'session_id' in e).length}`);
  for (const [, v] of mem) for (const e of v) log('ENTRY', JSON.stringify({ ...e, message: e.message ? '[...]' : undefined }).slice(0, 300));
} else if (scenario === 'q2') {
  const envPair = { CLAUDE_CODE_PROJECT_DIR_NAME: 'sess-abc123' };
  await runQuery('q2a fresh + PROJECT_DIR_NAME', { sessionId: id }, 'Say hi', envPair);
  await runQuery('q2b resume + PROJECT_DIR_NAME', { resume: id }, 'Say hi again', envPair);
  await runQuery('q2c fresh, NO PROJECT_DIR_NAME', { sessionId: crypto.randomUUID() }, 'Say hi');
} else if (scenario === 'q3') {
  await runQuery(`q3 flush=${process.env.PROBE_FLUSH ?? 'default'} appendDelay=${appendDelayMs}`, { sessionId: id, ...(process.env.PROBE_FLUSH ? { sessionStoreFlush: process.env.PROBE_FLUSH } : {}) }, 'Say hi');
  log(`after loop: appendCount=${appendCount}`);
} else if (scenario === 'q4') {
  await runQuery(`q4 resume miss loadMode=${loadMode}`, { resume: id }, 'Say hi');
}
log(`total model calls=${modelCalls} appends=${appendCount}`);
server.stop(true);
process.exit(0);

import { query } from "/Users/chengchao/code/mymemo/mymemo-agent/apps/in-vm-server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";
import { mkdtempSync, mkdirSync, copyFileSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';

const SP = '/private/tmp/claude-501/-Users-chengchao-code-mymemo-mymemo-agent/19b5a1fd-ec9b-463c-9f5d-599cb1cad50f/scratchpad/probe2';
const PIN = 'sess-probe2';
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${String(Date.now() - t0).padStart(6)}ms]`, ...a);
setTimeout(() => { log('WALLCLOCK CAP 150s HIT, exit 124'); process.exit(124); }, 150_000);
const sh = async (cmd: string) => (await $`sh -c ${cmd}`.nothrow().text()).trimEnd();
const tmp = (p: string) => mkdtempSync(join(SP, p));
const size = (p: string) => (existsSync(p) ? statSync(p).size : -1);

// ---- fake Anthropic Messages server (copied from probe/probe.ts) ----
let modelCalls = 0;
const msgLens: number[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method !== 'POST' || !url.pathname.endsWith('/messages')) {
      log('FAKE non-messages request', req.method, url.pathname);
      return new Response('{}', { status: 404 });
    }
    const body = await req.json() as { messages: any[] };
    modelCalls++;
    msgLens.push(body.messages.length);
    log(`FAKE model call #${modelCalls}: messages.length=${body.messages.length}`, JSON.stringify(body.messages.map((m: any) => ({ role: m.role, c: typeof m.content === 'string' ? m.content.slice(0, 30) : m.content.map((b: any) => b.type + ':' + (b.text ?? '').slice(0, 30)) }))));
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

type Res = { init?: string; resultSid?: string; isError?: boolean; result?: string; threw?: string; msgLens: number[] };
async function run(label: string, opts: Record<string, unknown>, prompt: string, cfg: string, cwd: string, pin: string | undefined): Promise<Res> {
  const env: Record<string, string | undefined> = { ...process.env, ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: 'fake-token', CLAUDE_CONFIG_DIR: cfg };
  delete env.ANTHROPIC_API_KEY;
  if (pin) env.CLAUDE_CODE_PROJECT_DIR_NAME = pin; else delete env.CLAUDE_CODE_PROJECT_DIR_NAME;
  log(`=== ${label} cfg=${cfg} cwd=${cwd} pin=${pin} opts=${JSON.stringify(opts)}`);
  const r: Res = { msgLens: [] };
  const before = modelCalls;
  const q = query({ prompt, options: { tools: [], permissionMode: 'dontAsk', maxTurns: 1, env, cwd, ...opts } as any });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const iterate = async () => {
    for await (const m of q as AsyncIterable<any>) {
      const extra: string[] = [];
      if (m.type === 'system' && m.subtype === 'init') { r.init = m.session_id; extra.push(`session_id=${m.session_id}`); }
      if (m.type === 'result') { r.resultSid = m.session_id; r.isError = m.is_error; r.result = JSON.stringify(m.result ?? m.errors ?? ''); extra.push(`subtype=${m.subtype} session_id=${m.session_id} is_error=${m.is_error} num_turns=${m.num_turns} result=${r.result.slice(0, 300)}`); }
      if (m.type === 'assistant') extra.push(JSON.stringify(m.message?.content).slice(0, 80));
      log(`ITER ${m.type}${m.subtype ? '/' + m.subtype : ''} ${extra.join(' ')}`);
    }
    log('ITER end');
  };
  try {
    await Promise.race([iterate(), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('per-query 40s timeout')), 40_000); })]);
  } catch (e) {
    r.threw = (e as Error).message; log(`QUERY THREW: ${r.threw}`);
    try { await (q as any).close?.(); } catch {}
  } finally { clearTimeout(timer); }
  r.msgLens = msgLens.slice(before);
  log(`--- ${label}: init=${r.init} resultSid=${r.resultSid} isError=${r.isError} threw=${r.threw ?? 'no'} modelMsgLens=${JSON.stringify(r.msgLens)}`);
  return r;
}
const inventory = async (dir: string) => log(`INVENTORY ${dir}:\n` + (await sh(`cd ${JSON.stringify(dir)} && find . -type f -exec stat -f '%z %N' {} + | sort -k2`)));
const jsonlTypes = (p: string) => { try { return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => { const e = JSON.parse(l); return `${e.type}${e.cwd ? '(cwd=' + e.cwd.split('/').pop() + ')' : ''}`; }).join(','); } catch (e) { return `unreadable: ${(e as Error).message}`; } };

const id = crypto.randomUUID();
log(`id=${id} fake=${base}`);
const summary: string[] = [];

// STEP 1: Turn 1 on host A
const A = tmp('cfgA-');
const r1 = await run('STEP1 turn1 on A', { sessionId: id }, 'Say hi', A, tmp('cwd1-'), PIN);
await inventory(A);
const jsonlA = join(A, 'projects', PIN, `${id}.jsonl`);
log(`STEP1 expected transcript ${jsonlA} exists=${existsSync(jsonlA)} size=${size(jsonlA)} entries=${jsonlTypes(jsonlA)}`);
summary.push(`STEP1 ${r1.init === id && !r1.isError && !r1.threw && existsSync(jsonlA) ? 'PASS' : 'FAIL'} init=${r1.init} msgLens=${JSON.stringify(r1.msgLens)} transcript=${jsonlA} size=${size(jsonlA)}`);

// STEP 2: copy projects/ only to host B
const B = tmp('cfgB-');
const tgz = join(SP, 't.tgz');
log(await sh(`tar -C ${JSON.stringify(A)} -czf ${JSON.stringify(tgz)} projects && tar -C ${JSON.stringify(B)} -xzf ${JSON.stringify(tgz)} && tar -tzvf ${JSON.stringify(tgz)}`));
log(`STEP2 tar size=${size(tgz)} bytes`);
await inventory(B);
summary.push(`STEP2 tar(projects only)=${size(tgz)} bytes`);

// STEP 3: Turn 2 on host B, different cwd
const jsonlB = join(B, 'projects', PIN, `${id}.jsonl`);
const r2 = await run('STEP3 turn2 resume on B (projects/ copy, new cwd)', { resume: id }, 'Say hi again', B, tmp('cwd2-'), PIN);
const sizeAfterT2 = size(jsonlB);
log(`STEP3 B transcript size after turn2=${sizeAfterT2} entries=${jsonlTypes(jsonlB)}`);
await inventory(B);
const grew = r2.msgLens.length === 1 && r2.msgLens[0]! > r1.msgLens[0]!;
summary.push(`STEP3 ${r2.init === id && !r2.isError && !r2.threw && grew ? 'PASS' : 'FAIL'} init=${r2.init} msgLens=${JSON.stringify(r2.msgLens)} (turn1 was ${JSON.stringify(r1.msgLens)}) isError=${r2.isError} threw=${r2.threw ?? 'no'} result=${r2.result}`);

// STEP 4: negative control, empty dir C
const C = tmp('cfgC-');
const r4 = await run('STEP4 resume in EMPTY C', { resume: id }, 'Say hi again', C, tmp('cwd4-'), PIN);
summary.push(`STEP4 ${r4.isError || r4.threw ? 'PASS(expected failure)' : 'FAIL(unexpectedly resumed)'} init=${r4.init} isError=${r4.isError} result=${r4.result} threw=${r4.threw ?? 'no'} msgLens=${JSON.stringify(r4.msgLens)}`);
await inventory(C);

// STEP 5: only the single JSONL (from A, turn-1 only) into D
const D = tmp('cfgD-');
mkdirSync(join(D, 'projects', PIN), { recursive: true });
copyFileSync(jsonlA, join(D, 'projects', PIN, `${id}.jsonl`));
await inventory(D);
const r5 = await run('STEP5 resume in D (single JSONL only)', { resume: id }, 'Say hi again', D, tmp('cwd5-'), PIN);
const grew5 = r5.msgLens.length === 1 && r5.msgLens[0]! > r1.msgLens[0]!;
summary.push(`STEP5 ${r5.init === id && !r5.isError && !r5.threw && grew5 ? 'PASS' : 'FAIL'} init=${r5.init} msgLens=${JSON.stringify(r5.msgLens)} isError=${r5.isError} threw=${r5.threw ?? 'no'} result=${r5.result}`);
await inventory(D);

// STEP 6: Turn 3 on B, measure growth
const r6 = await run('STEP6 turn3 resume on B', { resume: id }, 'Say hi a third time', B, tmp('cwd6-'), PIN);
const sizeAfterT3 = size(jsonlB);
const tgz3 = join(SP, 't3.tgz');
await sh(`tar -C ${JSON.stringify(B)} -czf ${JSON.stringify(tgz3)} projects`);
const gzOne = await sh(`gzip -c ${JSON.stringify(jsonlB)} | wc -c`);
log(`STEP6 B transcript entries=${jsonlTypes(jsonlB)}`);
summary.push(`STEP6 ${r6.init === id && !r6.isError && !r6.threw ? 'PASS' : 'FAIL'} msgLens=${JSON.stringify(r6.msgLens)} JSONL sizes: afterT1=${size(jsonlA)} afterT2=${sizeAfterT2} afterT3=${sizeAfterT3}; projects.tgz afterT3=${size(tgz3)} bytes; gzip(single jsonl)=${gzOne.trim()} bytes`);
await inventory(B);

// STEP 7: no PROJECT_DIR_NAME pin
const id7 = crypto.randomUUID();
const E = tmp('cfgE-');
const X = tmp('cwdX-');
const Y = tmp('cwdY-');
const r7a = await run('STEP7 turn1 on E, NO pin, cwd X', { sessionId: id7 }, 'Say hi', E, X, undefined);
await inventory(E);
const F = tmp('cfgF-');
const tgz7 = join(SP, 't7.tgz');
await sh(`tar -C ${JSON.stringify(E)} -czf ${JSON.stringify(tgz7)} projects && tar -C ${JSON.stringify(F)} -xzf ${JSON.stringify(tgz7)}`);
const r7b = await run('STEP7 resume on F, NO pin, cwd Y (different)', { resume: id7 }, 'Say hi again', F, Y, undefined);
summary.push(`STEP7a(no pin, cwd changes) init=${r7b.init} isError=${r7b.isError} threw=${r7b.threw ?? 'no'} result=${r7b.result} msgLens=${JSON.stringify(r7b.msgLens)} (turn1 was ${JSON.stringify(r7a.msgLens)})`);
await inventory(F);
const r7c = await run('STEP7 control: resume on F, NO pin, cwd X (same)', { resume: id7 }, 'Say hi again', F, X, undefined);
summary.push(`STEP7b(no pin, same cwd X) init=${r7c.init} isError=${r7c.isError} threw=${r7c.threw ?? 'no'} result=${r7c.result} msgLens=${JSON.stringify(r7c.msgLens)}`);
await inventory(F);

log('SUMMARY\n' + summary.join('\n'));
log(`total model calls=${modelCalls}`);
server.stop(true);
process.exit(0);

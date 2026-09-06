// #730 follow-up — the S3 Files export delay, measured properly:
//  A) several files via bash and via writeFiles, written at known moments, polled every 2 s
//  B) a file appended to every 10 s for 60 s — does the inactivity timer restart?
//  C) a second session on the same folder while the first is open — does another mount see files instantly?
import { BedrockAgentCoreClient, StartCodeInterpreterSessionCommand, InvokeCodeInterpreterCommand, StopCodeInterpreterSessionCommand } from "@aws-sdk/client-bedrock-agentcore";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { readFileSync } from "node:fs"; import { join } from "node:path";
const env = Object.fromEntries(readFileSync(join(import.meta.dir, "probe.env"), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const { CI_ID, BUCKET } = env; const ci = new BedrockAgentCoreClient({ region: "us-west-2" }); const s3 = new S3Client({ region: "us-west-2" });
const t0 = Date.now(); const log = (...a: unknown[]) => console.log(`[${String(Date.now() - t0).padStart(7)}ms]`, ...a);
const ms = (t: number) => Math.round(performance.now() - t);
async function call(sid: string, name: string, args: Record<string, unknown>) {
  const out = await ci.send(new InvokeCodeInterpreterCommand({ codeInterpreterIdentifier: CI_ID, sessionId: sid, name, arguments: args as never }));
  let r: Record<string, unknown> | null = null; for await (const ev of (out.stream ?? []) as AsyncIterable<Record<string, unknown>>) if (ev.result) r = ev.result as Record<string, unknown>;
  const sc = (r?.structuredContent ?? {}) as Record<string, unknown>; return { isError: r?.isError, stdout: String(sc.stdout ?? ""), stderr: String(sc.stderr ?? ""), content: r?.content };
}
const sh = (sid: string, c: string) => call(sid, "executeCommand", { command: c });
async function start(name: string) { const t = performance.now(); const s = await ci.send(new StartCodeInterpreterSessionCommand({ codeInterpreterIdentifier: CI_ID, name, sessionTimeoutSeconds: 900, clientToken: crypto.randomUUID() })); log(`START ${name} ${s.sessionId} in ${ms(t)} ms`); return s.sessionId!; }
const stop = (sid: string) => ci.send(new StopCodeInterpreterSessionCommand({ codeInterpreterIdentifier: CI_ID, sessionId: sid }));
const run = Date.now();
const written: Record<string, number> = {};   // key -> ms when the LAST write finished
const seen: Record<string, number> = {};      // key -> ms when it appeared in the bucket
const PREFIX = `conv-probe/p3-${run}-`;
const key = (n: string) => `conv-probe/p3-${run}-${n}${n.includes(".") ? "" : ".txt"}`;
async function poll() { const l = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX })); for (const o of l.Contents ?? []) if (o.Key && !(o.Key in seen)) { seen[o.Key] = Date.now(); log(`  bucket: ${o.Key} (${o.Size} B) ${written[o.Key] ? `+${seen[o.Key] - written[o.Key]} ms after last write` : "before write recorded?"}`); } }

const s1 = await start("p3-writer");
await sh(s1, "ln -s /mnt/ws ws; mkdir -p /mnt/ws/artifacts");
// A) bash-written and api-written files at t=0
for (const i of [1, 2, 3]) { await sh(s1, `echo bash-${i} > /mnt/ws/p3-${run}-bash-${i}.txt`); written[key(`bash-${i}`)] = Date.now(); }
for (const i of [1, 2, 3]) { const r = await call(s1, "writeFiles", { content: [{ path: `ws/p3-${run}-api-${i}.txt`, text: `api-${i}` }] }); written[key(`api-${i}`)] = Date.now(); if (r.isError) log("writeFiles error", r.content); }
await sh(s1, `dd if=/dev/urandom of=/mnt/ws/p3-${run}-big-2MiB.bin bs=1M count=2 2>/dev/null`); written[key("big-2MiB.bin")] = Date.now();
log("A) 7 files written; polling every 2 s");
// C) second session, concurrent
const s2 = await start("p3-reader");
const r2 = await sh(s2, `ls -la /mnt/ws/ | grep p3-${run} ; cat /mnt/ws/p3-${run}-bash-1.txt /mnt/ws/p3-${run}-api-1.txt`);
log(`C) second session sees the writer's files instantly:\n    ${r2.stdout.trim().replace(/\n/g, "\n    ")}`);
// B) a file appended every 10 s for 60 s (timer restart?) — in parallel with polling
const appendKey = key("append.txt"); let appendDone = false;
const appender = (async () => { for (let i = 1; i <= 7; i++) { await sh(s1, `echo tick-${i} >> /mnt/ws/p3-${run}-append.txt`); written[appendKey] = Date.now(); log(`  B) append #${i}`); if (i < 7) await Bun.sleep(10_000); } appendDone = true; log("  B) appends finished; timer should start now"); })();
const deadline = Date.now() + 240_000;
while (Date.now() < deadline && Object.keys(seen).length < 8) { await poll(); await Bun.sleep(2_000); }
await appender;
// C again: does the reader see the appended content while the writer is still open?
const r3 = await sh(s2, `cat /mnt/ws/p3-${run}-append.txt | wc -l`); log(`C) reader sees ${r3.stdout.trim()} appended lines`);
await stop(s2); await stop(s1); log("sessions stopped");
while (Date.now() < deadline + 120_000 && Object.keys(seen).length < 8) { await poll(); await Bun.sleep(2_000); }
const rows = Object.keys(written).sort().map((k) => `${k.replace(PREFIX, "")}\t${k in seen ? `${((seen[k] - written[k]) / 1000).toFixed(1)} s after last write` : "NOT SEEN"}`);
log("SUMMARY (delay from last write to object visible)\n  " + rows.join("\n  "));

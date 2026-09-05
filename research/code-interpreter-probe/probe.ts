// #730 Q2 — measure the custom Code Interpreter with the S3 Files mount on the real topology.
// Run after up.sh:  AWS_PROFILE=mymemo bun run probe.ts | tee results/probe.log
import { BedrockAgentCoreClient, StartCodeInterpreterSessionCommand, InvokeCodeInterpreterCommand, StopCodeInterpreterSessionCommand, GetCodeInterpreterSessionCommand } from "@aws-sdk/client-bedrock-agentcore";
import { S3Client, ListObjectsV2Command, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const env = Object.fromEntries(readFileSync(join(import.meta.dir, "probe.env"), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const { CI_ID, BUCKET } = env; if (!CI_ID || !BUCKET) throw new Error("run up.sh first (probe.env lacks CI_ID/BUCKET)");
const region = "us-west-2"; const ci = new BedrockAgentCoreClient({ region }); const s3 = new S3Client({ region });
const t0 = Date.now(); const log = (...a: unknown[]) => console.log(`[${String(Date.now() - t0).padStart(7)}ms]`, ...a);
const summary: Record<string, unknown> = {}; const ms = (t: number) => Math.round(performance.now() - t);
const stats = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return { n: s.length, min: s[0], median: s[Math.floor(s.length / 2)], max: s[s.length - 1] }; };

type Result = { content?: Array<Record<string, unknown>>; structuredContent?: Record<string, unknown>; isError?: boolean };
async function invoke(sessionId: string, name: string, args: Record<string, unknown>): Promise<{ ms: number; result: Result | null; eventKeys: string[] }> {
  const t = performance.now();
  const out = await ci.send(new InvokeCodeInterpreterCommand({ codeInterpreterIdentifier: CI_ID, sessionId, name, arguments: args as never }));
  let result: Result | null = null; const eventKeys: string[] = [];
  for await (const ev of (out.stream ?? []) as AsyncIterable<Record<string, unknown>>) { eventKeys.push(Object.keys(ev).join("|")); if (ev.result) result = ev.result as Result; else log("  non-result event", JSON.stringify(ev).slice(0, 300)); }
  return { ms: ms(t), result, eventKeys };
}
const text = (r: Result | null) => (r?.content ?? []).map((c) => (c.text as string) ?? ((c.resource as Record<string, unknown> | undefined)?.text as string) ?? (c.type === "resource" ? `<resource ${JSON.stringify((c.resource as Record<string, unknown>)?.mimeType)} blob=${String((c.resource as Record<string, unknown>)?.blob ?? "").length}B>` : JSON.stringify(c))).join("");
async function sh(sessionId: string, command: string, label = command.slice(0, 40)) {
  const r = await invoke(sessionId, "executeCommand", { command });
  const sc = r.result?.structuredContent ?? {};
  log(`$ ${label}  [${r.ms} ms, exit=${sc.exitCode}, execTime=${sc.executionTime}]`); const out = (sc.stdout as string | undefined) ?? text(r.result); if (out) console.log(out.replace(/^/gm, "    ")); if (sc.stderr) console.log(String(sc.stderr).replace(/^/gm, "  ! "));
  return { ...r, out };
}
async function startSession(label: string) {
  const t = performance.now();
  const s = await ci.send(new StartCodeInterpreterSessionCommand({ codeInterpreterIdentifier: CI_ID, name: label, sessionTimeoutSeconds: 900, clientToken: crypto.randomUUID() }));
  const startMs = ms(t); log(`START ${label}: sessionId=${s.sessionId} in ${startMs} ms`);
  const g = await ci.send(new GetCodeInterpreterSessionCommand({ codeInterpreterIdentifier: CI_ID, sessionId: s.sessionId! }));
  log(`  status=${g.status} mounts=${JSON.stringify((g as Record<string, unknown>).filesystemConfigurations ?? "n/a")}`);
  return { id: s.sessionId!, startMs };
}
async function stopSession(id: string) { const t = performance.now(); await ci.send(new StopCodeInterpreterSessionCommand({ codeInterpreterIdentifier: CI_ID, sessionId: id })); log(`STOP ${id} in ${ms(t)} ms`); return ms(t); }
const stamp = Date.now();

// ---- session 1: identity, mount, latency, egress, marker writes ----
const s1 = await startSession("probe-1"); summary.startMs1 = s1.startMs;
const first = await sh(s1.id, "true", "first executeCommand (spawn warm-up)"); summary.firstExecMs = first.ms;
const idOut = await sh(s1.id, "id; echo pwd=$(pwd); echo HOME=$HOME USER=$USER; uname -srm; head -2 /etc/os-release", "identity");
summary.identity = idOut.out?.trim();
const mountOut = await sh(s1.id, "mount | grep -E ' /mnt' || echo NO-MNT-MOUNT; echo; df -h /mnt/ws; echo; ls -lan /mnt/ws; echo; stat -c 'root %u:%g %a' /mnt/ws", "mount state");
summary.mount = mountOut.out?.trim();
const touch = await sh(s1.id, `touch /mnt/ws/.probe-touch && stat -c 'touched-as %u:%g %a' /mnt/ws/.probe-touch; mkdir -p /mnt/ws/artifacts && echo MKDIR_OK`, "write via bash");
summary.bashWrite = touch.out?.trim();
await sh(s1.id, "which bash python3 node rg git curl aws jq 2>&1; python3 --version; node --version", "toolchain");
// latency, N=5 each
const lat: Record<string, number[]> = { executeCommand: [], writeFiles: [], readFiles: [], listFiles: [] };
for (let i = 0; i < 5; i++) {
  lat.executeCommand.push((await invoke(s1.id, "executeCommand", { command: "true" })).ms);
  lat.writeFiles.push((await invoke(s1.id, "writeFiles", { content: [{ path: `/mnt/ws/lat-${i}.txt`, text: `lat ${i} ${stamp}` }] })).ms);
  lat.readFiles.push((await invoke(s1.id, "readFiles", { paths: [`/mnt/ws/lat-${i}.txt`] })).ms);
  lat.listFiles.push((await invoke(s1.id, "listFiles", { directoryPath: "/mnt/ws" })).ms);
}
summary.latencyMs = Object.fromEntries(Object.entries(lat).map(([k, v]) => [k, stats(v)])); log("LATENCY", JSON.stringify(summary.latencyMs));
const rel = await invoke(s1.id, "writeFiles", { content: [{ path: "rel-probe.txt", text: "relative path lands where?" }] });
await sh(s1.id, "find / -name rel-probe.txt -not -path '*/proc/*' 2>/dev/null", `relative writeFiles (${rel.ms} ms) → path`);
const big = await invoke(s1.id, "writeFiles", { content: [{ path: "/mnt/ws/big-1MiB.bin", text: "x".repeat(1 << 20) }] }); log(`writeFiles 1 MiB: ${big.ms} ms isError=${big.result?.isError}`); summary.write1MiBMs = big.ms;
const rd = await invoke(s1.id, "readFiles", { paths: ["/mnt/ws/lat-0.txt"] }); log(`readFiles content blocks: ${JSON.stringify(rd.result?.content).slice(0, 300)}`);
// egress (expect: none — no-route subnets)
const egress = await sh(s1.id, "getent hosts example.com; echo dns_rc=$?; curl -m 8 -sS -o /dev/null -w 'http=%{http_code}\\n' https://example.com; echo curl_rc=$?; curl -m 8 -sS -o /dev/null -w 'http=%{http_code}\\n' https://s3.us-west-2.amazonaws.com; echo s3_rc=$?", "egress probe");
summary.egress = egress.out?.trim();
// marker writes → S3 export lag
const markerApi = `conv-probe/marker-api-${stamp}.txt`, markerBash = `conv-probe/marker-bash-${stamp}.txt`;
const tWrite = Date.now();
await invoke(s1.id, "writeFiles", { content: [{ path: `/mnt/ws/marker-api-${stamp}.txt`, text: `api ${stamp}` }] });
await sh(s1.id, `echo bash ${stamp} > /mnt/ws/marker-bash-${stamp}.txt && sync && echo SYNC_OK`, "marker via bash");
summary.stopMs1 = await stopSession(s1.id);
log("polling the bucket for the markers (S3 Files export lag, expect ~60 s)…");
const seen: Record<string, number> = {};
for (let i = 0; i < 60 && Object.keys(seen).length < 2; i++) {
  const l = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `conv-probe/marker-` }));
  for (const o of l.Contents ?? []) if (o.Key && !(o.Key in seen) && (o.Key === markerApi || o.Key === markerBash)) { seen[o.Key] = Date.now() - tWrite; log(`  ${o.Key} visible after ${seen[o.Key]} ms (size ${o.Size})`); }
  if (Object.keys(seen).length < 2) await Bun.sleep(5000);
}
summary.exportLagMs = seen;
for (const k of Object.keys(seen)) { const h = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: k })); const b = await (await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: k }))).Body?.transformToString(); log(`  ${k}: body=${JSON.stringify(b?.trim())} metadata=${JSON.stringify(h.Metadata)}`); }
const all = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET })); log(`bucket keys now: ${(all.Contents ?? []).map((o) => o.Key).join(", ")}`);

// ---- session 2: persistence across sessions + second cold start ----
const s2 = await startSession("probe-2"); summary.startMs2 = s2.startMs;
const persist = await sh(s2.id, `ls -la /mnt/ws; cat /mnt/ws/marker-api-${stamp}.txt /mnt/ws/marker-bash-${stamp}.txt`, "session 2 sees session 1's files?");
summary.persistAcrossSessions = persist.out?.includes(`api ${stamp}`) && persist.out?.includes(`bash ${stamp}`);
summary.stopMs2 = await stopSession(s2.id);
// invoking a stopped session → error shape
try { await invoke(s2.id, "executeCommand", { command: "true" }); summary.stoppedSessionInvoke = "NO ERROR (!)"; } catch (e) { summary.stoppedSessionInvoke = `${(e as Error).name}: ${(e as Error).message}`; }
log("SUMMARY\n" + JSON.stringify(summary, null, 2));

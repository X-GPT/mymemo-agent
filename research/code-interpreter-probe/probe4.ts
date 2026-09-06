// No-mount design probe: SANDBOX-mode interpreter — network, start latency, tarball copy-in/out, path rules, identity.
import { BedrockAgentCoreClient, StartCodeInterpreterSessionCommand, InvokeCodeInterpreterCommand, StopCodeInterpreterSessionCommand } from "@aws-sdk/client-bedrock-agentcore";
import { readFileSync } from "node:fs"; import { join } from "node:path"; import { createHash } from "node:crypto";
const env = Object.fromEntries(readFileSync(join(import.meta.dir, "sandbox.env"), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const CI_ID = env.SBX_ID; const ci = new BedrockAgentCoreClient({ region: "us-west-2" });
const t0 = Date.now(); const log = (...a: unknown[]) => console.log(`[${String(Date.now() - t0).padStart(7)}ms]`, ...a);
const ms = (t: number) => Math.round(performance.now() - t);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex").slice(0, 16);
async function call(sid: string, name: string, args: Record<string, unknown>) {
  const t = performance.now();
  const out = await ci.send(new InvokeCodeInterpreterCommand({ codeInterpreterIdentifier: CI_ID, sessionId: sid, name, arguments: args as never }));
  let r: Record<string, unknown> | null = null; for await (const ev of (out.stream ?? []) as AsyncIterable<Record<string, unknown>>) if (ev.result) r = ev.result as Record<string, unknown>;
  const sc = (r?.structuredContent ?? {}) as Record<string, unknown>;
  return { ms: ms(t), isError: !!r?.isError, stdout: String(sc.stdout ?? ""), stderr: String(sc.stderr ?? ""), exit: sc.exitCode, content: (r?.content ?? []) as Array<Record<string, unknown>> };
}
async function sh(sid: string, c: string, label = c.slice(0, 70)) { const r = await call(sid, "executeCommand", { command: c }); log(`$ ${label} [${r.ms} ms exit=${r.exit}]`); const o = (r.stdout + (r.stderr ? "\n! " + r.stderr : "")).trim(); if (o) console.log(o.replace(/^/gm, "    ")); return r; }
const summary: Record<string, unknown> = {};
// 1) start latency ×3
const starts: number[] = []; let sid = "";
for (let i = 1; i <= 3; i++) { const t = performance.now(); const s = await ci.send(new StartCodeInterpreterSessionCommand({ codeInterpreterIdentifier: CI_ID, name: `sbx-${i}`, sessionTimeoutSeconds: 900, clientToken: crypto.randomUUID() })); starts.push(ms(t)); log(`START #${i} ${s.sessionId} in ${starts[i - 1]} ms`); if (i < 3) await ci.send(new StopCodeInterpreterSessionCommand({ codeInterpreterIdentifier: CI_ID, sessionId: s.sessionId! })); else sid = s.sessionId!; }
summary.startMs = starts;
// 2) identity, env, credentials
await sh(sid, "id; pwd; uname -srm; ls -la ~ | head -5", "identity");
const creds = await sh(sid, "env | grep -i -E 'aws|token|secret|key' | sed 's/=.*/=<set>/'; ls -la ~/.aws 2>&1; curl -s -m 3 http://169.254.169.254/latest/meta-data/ ; echo imds_rc=$?; curl -s -m 3 http://169.254.170.2/ ; echo ecs_creds_rc=$?; aws sts get-caller-identity 2>&1 | head -2", "credentials present?");
summary.credentials = creds.stdout.trim();
// 3) network
const net = await sh(sid, "getent hosts example.com; echo dns_rc=$?; curl -sS -m 6 -o /dev/null -w 'http=%{http_code}\\n' https://example.com; echo curl_rc=$?; curl -sS -m 6 -o /dev/null -w 'http=%{http_code}\\n' https://s3.us-west-2.amazonaws.com; echo s3_rc=$?; curl -sS -m 6 -o /dev/null -w 'http=%{http_code}\\n' https://bedrock-agentcore.us-west-2.amazonaws.com; echo agentcore_rc=$?; ip route 2>&1 | head -3; cat /etc/resolv.conf 2>&1 | head -3", "network");
summary.network = net.stdout.trim();
// 4) path rules
const abs = await call(sid, "writeFiles", { content: [{ path: "/tmp/abs.txt", text: "abs" }] }); log(`writeFiles ABSOLUTE /tmp/abs.txt -> isError=${abs.isError} ${JSON.stringify(abs.content).slice(0, 120)}`);
const rel = await call(sid, "writeFiles", { content: [{ path: "ws/rel.txt", text: "rel" }] }); log(`writeFiles RELATIVE ws/rel.txt -> isError=${rel.isError}`);
await sh(sid, "find / -name rel.txt -not -path '*/proc/*' 2>/dev/null; df -h . | tail -1", "where did it land + disk");
summary.pathRule = { absolute: abs.isError ? "rejected" : "accepted", relative: rel.isError ? "rejected" : "accepted" };
// 5) copy-in / copy-out with tarballs (5 MB and 50 MB of incompressible bytes, as blobs)
for (const mb of [5, 50]) {
  const bytes = new Uint8Array(mb * 1024 * 1024); crypto.getRandomValues(bytes.subarray(0, 65536)); for (let i = 65536; i < bytes.length; i += 65536) bytes.set(bytes.subarray(0, Math.min(65536, bytes.length - i)), i);
  const h = sha(bytes);
  const w = await call(sid, "writeFiles", { content: [{ path: `ws/in-${mb}.bin`, blob: bytes }] }); log(`copy-in ${mb} MB via writeFiles(blob): ${w.ms} ms isError=${w.isError} ${w.isError ? JSON.stringify(w.content).slice(0, 200) : ""}`);
  const v = await sh(sid, `sha256sum ws/in-${mb}.bin | cut -c1-16; ls -l ws/in-${mb}.bin | awk '{print $5}'`, `verify ${mb} MB in sandbox`);
  const rd = await call(sid, "readFiles", { paths: [`ws/in-${mb}.bin`] });
  const res = rd.content[0]?.resource as Record<string, unknown> | undefined; const blob = res?.blob; let back: Uint8Array | null = null;
  if (typeof blob === "string") back = Uint8Array.from(Buffer.from(blob, "base64")); else if (blob instanceof Uint8Array) back = blob;
  log(`copy-out ${mb} MB via readFiles: ${rd.ms} ms isError=${rd.isError} mime=${res?.mimeType} bytesBack=${back?.length ?? "n/a"} sha=${back ? sha(back) : "n/a"} (sent ${h}) match=${back ? sha(back) === h : false}`);
  summary[`copy${mb}MB`] = { inMs: w.ms, outMs: rd.ms, roundTrip: back ? sha(back) === h : false, sandboxSha: v.stdout.trim().split("\n")[0] };
}
// 6) tar round-trip of a small tree via executeCommand + readFiles (the real copy-out shape)
await sh(sid, "mkdir -p ws/artifacts ws/.mymemo/docs && for i in $(seq 1 200); do echo file-$i > ws/artifacts/f-$i.txt; done && tar czf /tmp/out.tgz -C ws . && ls -l /tmp/out.tgz | awk '{print $5}' && cp /tmp/out.tgz ws/out.tgz", "tar 200 small files");
const tg = await call(sid, "readFiles", { paths: ["ws/out.tgz"] }); log(`readFiles out.tgz: ${tg.ms} ms isError=${tg.isError}`);
await sh(sid, "which tar gzip zstd python3 node rg; python3 -c 'import pandas, numpy; print(pandas.__version__, numpy.__version__)'", "toolchain");
await ci.send(new StopCodeInterpreterSessionCommand({ codeInterpreterIdentifier: CI_ID, sessionId: sid }));
log("SUMMARY\n" + JSON.stringify(summary, null, 2));

// PROBE — throwaway. Direct hand measurements, no model: latency per op, streaming through the
// endpoint, output caps, export size, and the negative egress control.
import { hand, handGet, calls } from "./hand-client";
const r = async (label: string, f: () => Promise<unknown>) => { const t0 = performance.now(); try { const v = await f(); console.log(`${label}: ${Math.round(performance.now() - t0)}ms`, typeof v === "string" ? v : JSON.stringify(v).slice(0, 200)); } catch (e) { console.log(`${label}: FAIL ${Math.round(performance.now() - t0)}ms`, String((e as Error).message).slice(0, 200)); } };
await r("health", async () => (await handGet("health")).text());
for (let i = 0; i < 3; i++) await r(`bash echo #${i}`, () => hand("bash", { command: "echo hi" }));
await r("bash npm test", () => hand("bash", { command: "npm test" }));
await r("read math.js", () => hand("read", { path: "math.js" }));
await r("glob *.js", () => hand("glob", { pattern: "*.js" }));
await r("grep add", () => hand("grep", { pattern: "add" }));
await r("escape ../etc/passwd", () => hand("read", { path: "../../etc/passwd" }));
await r("big output 1MB", async () => { const x = await hand("bash", { command: "head -c 1048576 /dev/zero | base64" }); return { truncated: x.truncated, stdoutLen: x.stdout.length }; });
await r("timeout 2s", () => hand("bash", { command: "sleep 30", timeoutMs: 2000 }));
await r("egress example.com (informational — default connector has internet)", () => hand("bash", { command: "curl -sS -m 5 -o /dev/null -w '%{http_code}' https://example.com || echo CURL_FAILED_$?" }));
await r("egress IMDS", () => hand("bash", { command: "curl -sS -m 3 http://169.254.169.254/latest/meta-data/iam/security-credentials/ || echo IMDS_FAILED_$?" }));
await r("export tar.gz", async () => { const res = await handGet("export"); const buf = await res.arrayBuffer(); return { status: res.status, bytes: buf.byteLength }; });
console.log("\ncalls:", JSON.stringify(calls));

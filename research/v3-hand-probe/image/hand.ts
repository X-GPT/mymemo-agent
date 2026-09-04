// PROBE — throwaway (wayfinder #708). The v3 hand server: runs inside the Sandbox as the
// non-root `developer` user, holds no credential, initiates no network traffic, and answers
// only the platform-authenticated per-VM endpoint. Model-facing ops: bash, read, write, edit,
// glob, grep. Internal (Runner-only) op: export. Lifecycle hooks answer 200 and do nothing.
import { resolve, relative, isAbsolute } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";

const WS = process.env.WORKSPACE_DIR ?? "/home/developer/workspace";
const PORT = Number(process.env.HAND_PORT ?? 8080);
const CAP = 64 * 1024; // bytes per stream kept in a bash result (the Runner caps again below the SDK's 25k-token spill)

function inWs(p: string): string {
	const abs = resolve(WS, p);
	const rel = relative(WS, abs);
	if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`path escapes workspace: ${p}`);
	return abs;
}
const json = (body: unknown, status = 200) => Response.json(body, { status });
const cap = (s: string) => (s.length > CAP ? { text: s.slice(0, CAP), truncated: true } : { text: s, truncated: false });

async function bash(cmd: string, timeoutMs: number) {
	const t0 = performance.now();
	const proc = Bun.spawn(["bash", "-lc", cmd], { cwd: WS, stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: "/home/developer" } });
	const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
	const [out, err, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	clearTimeout(timer);
	const o = cap(out), e = cap(err);
	return { stdout: o.text, stderr: e.text, truncated: o.truncated || e.truncated, exitCode, timedOut: exitCode === 137 || exitCode === -1, durationMs: Math.round(performance.now() - t0) };
}

function bashStream(cmd: string, timeoutMs: number): Response {
	const proc = Bun.spawn(["bash", "-lc", cmd], { cwd: WS, stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
	const enc = new TextEncoder();
	const stream = new ReadableStream({
		async start(ctrl) {
			const ev = (type: string, data: unknown) => ctrl.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
			const pump = async (r: ReadableStream<Uint8Array>, name: string) => { for await (const chunk of r) ev(name, { chunk: new TextDecoder().decode(chunk), t: Date.now() }); };
			await Promise.all([pump(proc.stdout, "stdout"), pump(proc.stderr, "stderr")]);
			const exitCode = await proc.exited; clearTimeout(timer);
			ev("exit", { exitCode, t: Date.now() }); ctrl.close();
		},
	});
	return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

Bun.serve({
	port: PORT, hostname: "0.0.0.0", idleTimeout: 255,
	async fetch(req) {
		const url = new URL(req.url);
		const path = url.pathname;
		try {
			if (req.method === "GET" && (path === "/health" || path === "/ready")) return json({ ok: true, ws: WS, t: Date.now() });
			if (req.method === "POST" && ["/run", "/resume", "/suspend", "/terminate"].includes(path)) return json({ ok: true, hook: path });
			if (req.method === "GET" && path === "/export") {
				const proc = Bun.spawn(["tar", "-C", WS, "-czf", "-", "."], { stdout: "pipe" });
				return new Response(proc.stdout, { headers: { "content-type": "application/gzip" } });
			}
			if (req.method !== "POST") return json({ error: "not found" }, 404);
			const body = (await req.json()) as Record<string, any>;
			switch (path) {
				case "/bash": return json(await bash(String(body.command), Number(body.timeoutMs ?? 120_000)));
				case "/bash/stream": return bashStream(String(body.command), Number(body.timeoutMs ?? 120_000));
				case "/read": { const text = await readFile(inWs(body.path), "utf8"); const lines = text.split("\n"); const off = Number(body.offset ?? 0), lim = Number(body.limit ?? 2000); return json({ text: lines.slice(off, off + lim).join("\n"), totalLines: lines.length }); }
				case "/write": { const p = inWs(body.path); await mkdir(resolve(p, ".."), { recursive: true }); await writeFile(p, String(body.content)); return json({ ok: true, path: body.path }); }
				case "/edit": { const p = inWs(body.path); const text = await readFile(p, "utf8"); const n = text.split(String(body.old)).length - 1; if (n === 0) return json({ error: "old_string not found" }, 409); if (n > 1 && !body.replaceAll) return json({ error: `old_string matches ${n} times; pass replaceAll` }, 409); await writeFile(p, body.replaceAll ? text.split(String(body.old)).join(String(body.new)) : text.replace(String(body.old), String(body.new))); return json({ ok: true, replaced: body.replaceAll ? n : 1 }); }
				case "/glob": { const g = new Bun.Glob(String(body.pattern)); const files: string[] = []; for await (const f of g.scan({ cwd: WS, dot: false })) { files.push(f); if (files.length >= 500) break; } return json({ files }); }
				case "/grep": { const args = ["grep", "-rn", "-E", "--", String(body.pattern), body.glob ? `--include=${body.glob}` : ".", ...(body.glob ? ["."] : [])]; const r = await bash(args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" "), 30_000); return json({ matches: r.stdout, truncated: r.truncated, exitCode: r.exitCode }); }
				default: return json({ error: "not found" }, 404);
			}
		} catch (e) { return json({ error: String((e as Error).message ?? e) }, 400); }
	},
});
console.log(`hand listening on :${PORT} ws=${WS}`);

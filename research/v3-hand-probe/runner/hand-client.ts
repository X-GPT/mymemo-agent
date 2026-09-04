// PROBE — throwaway. Runner-side client for the hand server. Talks to either a local hand
// (http://localhost:8080, no token) or a MicroVM endpoint (https://<id>.lambda-microvm.<region>.on.aws
// with the platform JWE in X-aws-proxy-auth).
export type HandCall = { op: string; ms: number; ok: boolean; bytes: number };
export const calls: HandCall[] = [];

const base = (process.env.HAND_URL ?? "http://localhost:8080").replace(/\/$/, "");
const token = process.env.HAND_TOKEN;
const headers: Record<string, string> = { "content-type": "application/json" };
if (token) { headers["x-aws-proxy-auth"] = token; headers["x-aws-proxy-port"] = process.env.HAND_PORT ?? "8080"; }

export async function hand<T = any>(op: string, body: unknown): Promise<T> {
	const t0 = performance.now();
	let ok = false, bytes = 0;
	try {
		const res = await fetch(`${base}/${op}`, { method: "POST", headers, body: JSON.stringify(body) });
		const text = await res.text(); bytes = text.length; ok = res.ok;
		if (!res.ok) throw new Error(`hand ${op} ${res.status}: ${text.slice(0, 300)}`);
		return JSON.parse(text) as T;
	} finally { calls.push({ op, ms: Math.round(performance.now() - t0), ok, bytes }); }
}
export async function handGet(op: string): Promise<Response> {
	const h = { ...headers }; delete h["content-type"];
	return fetch(`${base}/${op}`, { headers: h });
}
export async function handStream(command: string, onEvent: (type: string, data: any) => void, timeoutMs = 120_000) {
	const res = await fetch(`${base}/bash/stream`, { method: "POST", headers, body: JSON.stringify({ command, timeoutMs }) });
	if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
	const dec = new TextDecoder(); let buf = "";
	for await (const chunk of res.body) {
		buf += dec.decode(chunk, { stream: true });
		let i; while ((i = buf.indexOf("\n\n")) >= 0) { const frame = buf.slice(0, i); buf = buf.slice(i + 2); const type = /^event: (.*)$/m.exec(frame)?.[1]; const data = /^data: (.*)$/m.exec(frame)?.[1]; if (type && data) onEvent(type, JSON.parse(data)); }
	}
}

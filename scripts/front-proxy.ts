import { Sha256 } from "@aws-crypto/sha256-js";
import { fromIni } from "@aws-sdk/credential-providers";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";

export function createProxy(
	base: URL,
	signer: SignatureV4,
	identity: Record<string, string>,
	origin: string,
) {
	return async (request: Request): Promise<Response> => {
		if (
			request.headers.get("origin") &&
			request.headers.get("origin") !== origin
		)
			return new Response("Origin forbidden", { status: 403 });
		const cors = {
			"access-control-allow-origin": origin,
			"access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
			"access-control-allow-headers": "content-type",
			"access-control-expose-headers": "x-vercel-ai-ui-message-stream",
			vary: "Origin",
		};
		if (request.method === "OPTIONS")
			return new Response(null, { headers: cors });
		const incoming = new URL(request.url);
		// Set fields rather than resolving a caller-controlled //host against base.
		const target = new URL(base);
		target.pathname = incoming.pathname;
		target.search = incoming.search;
		const body = ["GET", "HEAD"].includes(request.method)
			? undefined
			: new Uint8Array(await request.arrayBuffer());
		const query: Record<string, string[]> = {};
		for (const [key, value] of target.searchParams) {
			query[key] ??= [];
			query[key].push(value);
		}
		const signed = await signer.sign(
			new HttpRequest({
				protocol: target.protocol,
				hostname: target.hostname,
				port: target.port ? Number(target.port) : undefined,
				method: request.method,
				path: target.pathname,
				query,
				body,
				headers: {
					host: target.host,
					...identity,
					...(request.headers.has("content-type")
						? {
								"content-type":
									request.headers.get("content-type") ?? "application/json",
							}
						: {}),
				},
			}),
		);
		const response = await fetch(target, {
			method: request.method,
			headers: signed.headers,
			body,
			signal: request.signal,
			redirect: "manual",
			decompress: false,
		});
		const headers = new Headers(response.headers);
		for (const [key, value] of Object.entries(cors)) headers.set(key, value);
		return new Response(response.body, { status: response.status, headers });
	};
}

if (import.meta.main) {
	const base = new URL(process.env.FRONT_FUNCTION_URL ?? "");
	if (
		base.protocol !== "https:" ||
		!/^[a-z0-9]+\.lambda-url\.us-west-2\.on\.aws$/.test(base.hostname)
	)
		throw new Error(
			"FRONT_FUNCTION_URL must be a us-west-2 Lambda Function URL",
		);
	const member = process.env.FRONT_MEMBER_CODE;
	const partner = process.env.FRONT_PARTNER_CODE;
	if (!member || !partner)
		throw new Error("FRONT_MEMBER_CODE and FRONT_PARTNER_CODE are required");
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: Number(process.env.PORT ?? 3001),
		idleTimeout: 0,
		maxRequestBodySize: 10 * 1024 * 1024,
		fetch: createProxy(
			base,
			new SignatureV4({
				credentials: fromIni({ profile: "mymemo" }),
				region: "us-west-2",
				service: "lambda",
				sha256: Sha256,
			}),
			{
				"x-member-code": member,
				"x-partner-code": partner,
				...(process.env.FRONT_TEAM_CODE
					? { "x-team-code": process.env.FRONT_TEAM_CODE }
					: {}),
			},
			process.env.FRONT_BROWSER_ORIGIN ?? "http://localhost:3000",
		),
	});
	console.log(`Signing proxy listening on ${server.url}`);
}

import invariant from "tiny-invariant";

function parsePort(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const n = Number(value);
	invariant(
		Number.isInteger(n) && n > 0 && n < 65536,
		`GATEWAY_PORT must be an integer in 1..65535, got: ${value}`,
	);
	return n;
}

/**
 * If DATABASE_URL is passwordless (e.g. `postgresql://user@host/db`, the form the
 * platform injects) and DB_PASSWORD is set, splice the password into the URL.
 */
function withPassword(url: string, password: string | undefined): string {
	if (!password) return url;
	const m = /^([a-z]+:\/\/)([^@/]+)@(.*)$/i.exec(url);
	if (!m) return url;
	const [, scheme, userinfo, rest] = m;
	if (!scheme || !userinfo || rest === undefined) return url;
	if (userinfo.includes(":")) return url; // already has a password
	return `${scheme}${userinfo}:${encodeURIComponent(password)}@${rest}`;
}

/** Append `sslmode=require` unless TLS is disabled or the URL already sets it. */
function withSsl(url: string, enabled: boolean): string {
	if (!enabled || /[?&]sslmode=/.test(url)) return url;
	return `${url}${url.includes("?") ? "&" : "?"}sslmode=require`;
}

/**
 * Environment for the merged gateway — the single control plane for sandboxed
 * agents. This is the only service that holds BOTH the real provider key
 * (ANTHROPIC_API_KEY) and the read-only KB credential (DATABASE_URL); keep its
 * surface tiny. Validated at module load.
 *
 * Uses a dedicated GATEWAY_PORT (not the generic PORT) so it never collides with
 * another co-located service reading the same injected env.
 */
export const gwEnv = (() => {
	invariant(Bun.env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY is required");
	invariant(Bun.env.DATABASE_URL, "DATABASE_URL is required");
	invariant(Bun.env.LLM_TOKEN_SECRET, "LLM_TOKEN_SECRET is required");

	return {
		// The real provider key — injected as x-api-key on the Anthropic proxy.
		ANTHROPIC_API_KEY: Bun.env.ANTHROPIC_API_KEY,
		// Shared with chat-api (which mints the per-turn token) so we can verify it.
		LLM_TOKEN_SECRET: Bun.env.LLM_TOKEN_SECRET,
		// Read-only connection to the KB Postgres (the same RDS the platform uses).
		// DB_PASSWORD is spliced in when DATABASE_URL is passwordless; TLS is on by
		// default (set DB_SSL=disable for a local non-TLS Postgres).
		DATABASE_URL: withSsl(
			withPassword(Bun.env.DATABASE_URL, Bun.env.DB_PASSWORD),
			Bun.env.DB_SSL !== "disable",
		),
		// Trailing slash stripped so `${base}${path}` never yields a double slash.
		UPSTREAM_BASE_URL: (
			Bun.env.UPSTREAM_BASE_URL || "https://api.anthropic.com"
		).replace(/\/+$/, ""),
		GATEWAY_PORT: parsePort(Bun.env.GATEWAY_PORT, 8080),
	} as const;
})();

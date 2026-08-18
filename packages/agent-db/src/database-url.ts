/**
 * Resolve the platform's passwordless Postgres URL and shared TLS policy.
 * `sslmode=no-verify` keeps the connection encrypted while the runtime does not
 * ship the Amazon RDS CA; callers may disable TLS only for local Postgres.
 */
export function resolveDatabaseUrl(
	databaseUrl: string,
	dbPassword: string | undefined,
	dbSsl: string | undefined,
): string;
export function resolveDatabaseUrl(
	databaseUrl: undefined,
	dbPassword: string | undefined,
	dbSsl: string | undefined,
): undefined;
export function resolveDatabaseUrl(
	databaseUrl: string | undefined,
	dbPassword: string | undefined,
	dbSsl: string | undefined,
): string | undefined;
export function resolveDatabaseUrl(
	databaseUrl: string | undefined,
	dbPassword: string | undefined,
	dbSsl: string | undefined,
): string | undefined {
	if (!databaseUrl) return undefined;
	let resolved = databaseUrl;
	if (dbPassword) {
		const match = /^([a-z]+:\/\/)([^@/]+)@(.*)$/i.exec(resolved);
		if (match) {
			const [, scheme, userinfo, rest] = match;
			if (scheme && userinfo && rest !== undefined && !userinfo.includes(":")) {
				resolved = `${scheme}${userinfo}:${encodeURIComponent(dbPassword)}@${rest}`;
			}
		}
	}
	if (dbSsl !== "disable" && !/[?&]sslmode=/.test(resolved)) {
		resolved = `${resolved}${resolved.includes("?") ? "&" : "?"}sslmode=no-verify`;
	}
	return resolved;
}

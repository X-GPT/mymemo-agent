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
	let resolved: URL;
	try {
		resolved = new URL(databaseUrl);
	} catch {
		return databaseUrl;
	}
	if (dbPassword && !resolved.password) {
		resolved.password = dbPassword;
	}
	if (dbSsl !== "disable" && !resolved.searchParams.has("sslmode")) {
		resolved.searchParams.set("sslmode", "no-verify");
	}
	return resolved.toString();
}

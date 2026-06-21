/**
 * Hydration policy — bounds how much `search_documents` pulls into a conversation
 * workspace.
 *
 * One sandbox-side cap remains:
 *
 *   - `maxDocumentsPerSearch`: distinct documents hydrated per search call. A
 *     working-set / context-size knob — it bounds how many docs one search drops
 *     into the agent's context, not a cost/abuse boundary.
 *
 * The byte ceilings that used to live here are gone:
 *   - Per-document size is bounded server-side by the gateway, which clips every
 *     fetch to a fixed length before returning it — a sandbox-side per-document
 *     cap was redundant.
 *   - There is no per-run byte cap. A sandbox-side ledger is tamperable (the
 *     prompt-injectable agent owns its filesystem), and the per-turn blast radius
 *     is already bounded by the per-fetch clip and the agent turn timeout, so a
 *     run-level byte budget was judged not worth the complexity. If shared-DB
 *     fetch cost becomes a real concern, the right tool is a gateway-side fetch
 *     rate limit, not a byte ledger here.
 *
 * Limits are data, not behavior: this module holds no fs/network access and is
 * pure so the cap is unit-testable and the same default applies in tests and
 * prod. Operators override it through environment (see {@link loadHydrationLimits}).
 */

/** The sandbox-side hydration cap enforced by `searchAndHydrate`. */
export interface HydrationLimits {
	/** Max distinct documents hydrated per `search_documents` call. */
	maxDocumentsPerSearch: number;
}

/**
 * Default working set per search. Bounds how many documents one search drops
 * into the agent's context; cumulative fetch cost across a run is bounded
 * separately by the gateway, so this can be generous.
 */
export const DEFAULT_HYDRATION_LIMITS: HydrationLimits = {
	maxDocumentsPerSearch: 10,
};

/** Environment variable names that override each default limit. */
export const HYDRATION_LIMIT_ENV = {
	maxDocumentsPerSearch: "HYDRATION_MAX_DOCUMENTS_PER_SEARCH",
} as const satisfies Record<keyof HydrationLimits, string>;

/**
 * The hydration-limit env vars that are actually set, as a plain object suitable
 * for forwarding into the agent child's env. `Bun.spawn` replaces (does not
 * inherit) the child env, so without this the child's `loadHydrationLimits()`
 * would never see operator overrides and would silently use the defaults. Unset
 * vars are omitted so they stay genuinely unset in the child.
 */
export function hydrationLimitEnv(
	env: Record<string, string | undefined> = process.env,
): Record<string, string> {
	const forwarded: Record<string, string> = {};
	for (const name of Object.values(HYDRATION_LIMIT_ENV)) {
		const value = env[name];
		if (value !== undefined && value !== "") forwarded[name] = value;
	}
	return forwarded;
}

/**
 * Parse one limit env var: unset → the default; present → a positive integer.
 * Anything else (non-numeric, zero, negative, fractional) is a misconfiguration
 * that throws rather than silently falling back, so a typo can't quietly disable
 * a cap.
 */
function parseLimit(
	env: Record<string, string | undefined>,
	name: string,
	fallback: number,
): number {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(
			`${name} must be a positive integer, got ${JSON.stringify(raw)}`,
		);
	}
	return value;
}

/**
 * Build {@link HydrationLimits} from the environment, falling back to
 * {@link DEFAULT_HYDRATION_LIMITS} for any unset var. Throws on an invalid
 * (non-positive-integer) override. The env is injectable for tests; it defaults
 * to `process.env`.
 */
export function loadHydrationLimits(
	env: Record<string, string | undefined> = process.env,
): HydrationLimits {
	return {
		maxDocumentsPerSearch: parseLimit(
			env,
			HYDRATION_LIMIT_ENV.maxDocumentsPerSearch,
			DEFAULT_HYDRATION_LIMITS.maxDocumentsPerSearch,
		),
	};
}

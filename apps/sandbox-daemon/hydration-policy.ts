/**
 * Hydration limits — the single policy module that bounds how much
 * `search_documents` is allowed to pull into a conversation workspace.
 *
 * Three independent caps, enforced by {@link ./search-documents.searchAndHydrate}:
 *
 *   - `maxDocumentsPerSearch`: distinct documents hydrated per search call.
 *   - `maxBytesPerDocument`: bytes of fetched content written for one document.
 *     An oversized document is reported, NOT written to disk.
 *   - `maxBytesPerRun`: cumulative hydrated bytes attributed to one `runId`,
 *     summed across every `search_documents` call in that run.
 *
 * The point is to keep one prompt-injectable turn from filling the sandbox disk
 * (or running up gateway fetch cost) regardless of how the agent chains calls.
 * Limits are data, not behavior: this module holds no fs/network access and is
 * pure so the caps are unit-testable and the same defaults apply in tests and
 * prod. Operators override them through environment (see {@link loadHydrationLimits}).
 */

/** The three hydration caps enforced by `searchAndHydrate`. */
export interface HydrationLimits {
	/** Max distinct documents hydrated per `search_documents` call. */
	maxDocumentsPerSearch: number;
	/** Max bytes of content written to disk for a single document. */
	maxBytesPerDocument: number;
	/** Max cumulative hydrated bytes attributed to one run. */
	maxBytesPerRun: number;
}

/**
 * Conservative defaults. A document over 1 MB is almost certainly not a useful
 * working-set file, and 5 MB of hydrated text per run is already a large
 * context; both are sized to be generous for real notes/docs yet still bound a
 * runaway loop. `maxDocumentsPerSearch` keeps a single search from dominating
 * the per-run byte budget with many small files.
 */
export const DEFAULT_HYDRATION_LIMITS: HydrationLimits = {
	maxDocumentsPerSearch: 5,
	maxBytesPerDocument: 1_000_000,
	maxBytesPerRun: 5_000_000,
};

/** Environment variable names that override each default limit. */
export const HYDRATION_LIMIT_ENV = {
	maxDocumentsPerSearch: "HYDRATION_MAX_DOCUMENTS_PER_SEARCH",
	maxBytesPerDocument: "HYDRATION_MAX_BYTES_PER_DOCUMENT",
	maxBytesPerRun: "HYDRATION_MAX_BYTES_PER_RUN",
} as const satisfies Record<keyof HydrationLimits, string>;

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
		maxBytesPerDocument: parseLimit(
			env,
			HYDRATION_LIMIT_ENV.maxBytesPerDocument,
			DEFAULT_HYDRATION_LIMITS.maxBytesPerDocument,
		),
		maxBytesPerRun: parseLimit(
			env,
			HYDRATION_LIMIT_ENV.maxBytesPerRun,
			DEFAULT_HYDRATION_LIMITS.maxBytesPerRun,
		),
	};
}

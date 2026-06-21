import { describe, expect, it } from "bun:test";
import {
	DEFAULT_HYDRATION_LIMITS,
	HYDRATION_LIMIT_ENV,
	hydrationLimitEnv,
	loadHydrationLimits,
} from "./hydration-policy";

describe("loadHydrationLimits", () => {
	it("returns the defaults when no env vars are set", () => {
		expect(loadHydrationLimits({})).toEqual(DEFAULT_HYDRATION_LIMITS);
	});

	it("treats an empty-string override as unset (uses the default)", () => {
		expect(
			loadHydrationLimits({
				[HYDRATION_LIMIT_ENV.maxDocumentsPerSearch]: "",
			}),
		).toEqual(DEFAULT_HYDRATION_LIMITS);
	});

	it("overrides the limit from the environment", () => {
		expect(
			loadHydrationLimits({
				[HYDRATION_LIMIT_ENV.maxDocumentsPerSearch]: "2",
			}),
		).toEqual({ maxDocumentsPerSearch: 2 });
	});

	it("throws on a non-positive-integer override rather than silently disabling a cap", () => {
		for (const bad of ["0", "-1", "1.5", "abc", "ten"]) {
			expect(() =>
				loadHydrationLimits({
					[HYDRATION_LIMIT_ENV.maxDocumentsPerSearch]: bad,
				}),
			).toThrow(HYDRATION_LIMIT_ENV.maxDocumentsPerSearch);
		}
	});
});

describe("hydrationLimitEnv", () => {
	it("returns an empty object when no limit vars are set", () => {
		expect(hydrationLimitEnv({})).toEqual({});
	});

	it("forwards only the limit vars that are set, omitting unset/empty ones", () => {
		expect(
			hydrationLimitEnv({
				[HYDRATION_LIMIT_ENV.maxDocumentsPerSearch]: "7",
				UNRELATED: "ignored",
			}),
		).toEqual({ [HYDRATION_LIMIT_ENV.maxDocumentsPerSearch]: "7" });
	});

	it("passes values through verbatim (validation happens at load time, not forward time)", () => {
		// Forwarding is dumb on purpose: the child's loadHydrationLimits() is what
		// validates, so an invalid value is forwarded and rejected there.
		expect(
			hydrationLimitEnv({ [HYDRATION_LIMIT_ENV.maxDocumentsPerSearch]: "abc" }),
		).toEqual({ [HYDRATION_LIMIT_ENV.maxDocumentsPerSearch]: "abc" });
	});
});

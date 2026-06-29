import type { ApiConfig } from "@/config/env";
import {
	BreakGlassExposureGate,
	createStatsigExposureGate,
	type ExposureGate,
} from "./exposure-gate";

export {
	AGENT_EXPOSURE_GATE,
	BreakGlassExposureGate,
	type ExposureGate,
	StatsigExposureGate,
} from "./exposure-gate";

interface GateLogger {
	error(obj: Record<string, unknown>): void;
}

/**
 * Pick the exposure gate from config. Operator break-glass short-circuits to an
 * always-allow gate (and needs no Statsig secret); otherwise build the
 * Statsig-backed, fail-closed gate. `statsigServerSecret` is guaranteed present
 * here when break-glass is off — env validation requires it.
 */
export function createExposureGate(
	config: ApiConfig,
	logger?: GateLogger,
): ExposureGate {
	if (config.agentExposureBreakGlass) {
		return new BreakGlassExposureGate();
	}
	// Non-null: loadApiConfigFromEnv requires the secret unless break-glass is on.
	return createStatsigExposureGate(
		config.statsigServerSecret as string,
		{},
		logger,
	);
}

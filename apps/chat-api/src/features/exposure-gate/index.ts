import type { ApiConfig } from "@/config/env";
import { createStatsigExposureGate, type ExposureGate } from "./exposure-gate";

export {
	AGENT_EXPOSURE_GATE,
	type ExposureGate,
	StatsigExposureGate,
} from "./exposure-gate";

interface GateLogger {
	error(obj: Record<string, unknown>): void;
}

/**
 * Build the production fail-closed Statsig exposure gate.
 */
export function createExposureGate(
	config: ApiConfig,
	logger?: GateLogger,
): ExposureGate {
	return createStatsigExposureGate(config.statsigServerSecret, {}, logger);
}

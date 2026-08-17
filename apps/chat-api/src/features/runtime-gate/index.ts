import type { ApiConfig } from "@/config/env";
import {
	BreakGlassRuntimeGate,
	createStatsigRuntimeGate,
	type RuntimeGate,
} from "./runtime-gate";

export {
	AGENTCORE_RUNTIME_GATE,
	BreakGlassRuntimeGate,
	type RuntimeGate,
	type StatsigClientLike,
	StatsigRuntimeGate,
} from "./runtime-gate";

interface GateLogger {
	error(obj: Record<string, unknown>): void;
}

export function createRuntimeGate(
	config: ApiConfig,
	logger?: GateLogger,
): RuntimeGate {
	if (config.agentExposureBreakGlass) {
		return new BreakGlassRuntimeGate();
	}
	return createStatsigRuntimeGate(
		config.statsigServerSecret as string,
		{},
		logger,
	);
}

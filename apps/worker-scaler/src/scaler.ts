import type { ConversationQueueMetrics } from "@mymemo/agent-db/queue-metrics";

export interface WorkerScalerConfig {
	minTasks: number;
	maxTasks: number;
	/**
	 * How many concurrent Conversations one worker task serves (ADR-0015): a
	 * claimed Conversation holds one worker slot for its whole drain, so this
	 * mirrors the worker's per-task concurrency cap. The env var name
	 * (`WORKER_SCALER_TARGET_CONCURRENT_RUNS_PER_TASK`) predates the
	 * Conversation unit and is kept for config stability.
	 */
	targetConcurrentConversationsPerTask: number;
	scaleInCooldownMs: number;
}

export interface WorkerScalerState {
	currentDesiredTasks: number;
	lastScaleInAt: Date | null;
}

export interface ScalerStateStore {
	readState(): Promise<WorkerScalerState>;
	writeState(next: WorkerScalerState): Promise<void>;
}

export interface DesiredCountAdapter {
	updateDesiredCount(desiredTasks: number): Promise<void>;
}

export type ScaleDirection = "in" | "out" | "none";
export type ScaleDecisionReason =
	| "queue_depth"
	| "scale_in_cooldown"
	| "already_desired";

export interface ScaleDecision {
	desiredTasks: number;
	shouldUpdateService: boolean;
	scaleDirection: ScaleDirection;
	reason: ScaleDecisionReason;
}

export interface DecideWorkerScaleInput {
	metrics: ConversationQueueMetrics;
	config: WorkerScalerConfig;
	state: WorkerScalerState;
	now: Date;
}

export interface RunWorkerScalerInput {
	readMetrics(): Promise<ConversationQueueMetrics>;
	desiredCountAdapter: DesiredCountAdapter;
	stateStore: ScalerStateStore;
	config: WorkerScalerConfig;
	now?: Date;
}

export interface RunWorkerScalerResult {
	metrics: ConversationQueueMetrics;
	decision: ScaleDecision;
}

export function computeDesiredWorkerTasks(
	metrics: ConversationQueueMetrics,
	config: WorkerScalerConfig,
): number {
	validateMetrics(metrics);
	validateConfig(config);

	const rawDesired = Math.ceil(
		(metrics.demandConversations + metrics.ownedConversations) /
			config.targetConcurrentConversationsPerTask,
	);
	return clamp(rawDesired, config.minTasks, config.maxTasks);
}

export function decideWorkerScale(
	input: DecideWorkerScaleInput,
): ScaleDecision {
	const computedDesired = computeDesiredWorkerTasks(
		input.metrics,
		input.config,
	);

	if (
		computedDesired < input.state.currentDesiredTasks &&
		input.state.lastScaleInAt !== null &&
		input.now.getTime() - input.state.lastScaleInAt.getTime() <
			input.config.scaleInCooldownMs
	) {
		return {
			desiredTasks: input.state.currentDesiredTasks,
			shouldUpdateService: false,
			scaleDirection: "none",
			reason: "scale_in_cooldown",
		};
	}

	if (computedDesired === input.state.currentDesiredTasks) {
		return {
			desiredTasks: computedDesired,
			shouldUpdateService: false,
			scaleDirection: "none",
			reason: "already_desired",
		};
	}

	return {
		desiredTasks: computedDesired,
		shouldUpdateService: true,
		scaleDirection:
			computedDesired > input.state.currentDesiredTasks ? "out" : "in",
		reason: "queue_depth",
	};
}

export async function runWorkerScaler(
	input: RunWorkerScalerInput,
): Promise<RunWorkerScalerResult> {
	const now = input.now ?? new Date();
	const [metrics, state] = await Promise.all([
		input.readMetrics(),
		input.stateStore.readState(),
	]);
	const decision = decideWorkerScale({
		metrics,
		config: input.config,
		state,
		now,
	});

	if (decision.shouldUpdateService) {
		await input.desiredCountAdapter.updateDesiredCount(decision.desiredTasks);
		if (decision.scaleDirection === "in") {
			await input.stateStore.writeState({
				currentDesiredTasks: decision.desiredTasks,
				lastScaleInAt: now,
			});
		}
	}

	return { metrics, decision };
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

function validateConfig(config: WorkerScalerConfig): void {
	if (!Number.isInteger(config.minTasks) || config.minTasks < 0) {
		throw new Error("minTasks must be a non-negative integer");
	}
	if (!Number.isInteger(config.maxTasks) || config.maxTasks < config.minTasks) {
		throw new Error(
			"maxTasks must be an integer greater than or equal to minTasks",
		);
	}
	if (
		!Number.isInteger(config.targetConcurrentConversationsPerTask) ||
		config.targetConcurrentConversationsPerTask <= 0
	) {
		throw new Error(
			"targetConcurrentConversationsPerTask must be a positive integer",
		);
	}
	if (
		!Number.isInteger(config.scaleInCooldownMs) ||
		config.scaleInCooldownMs < 0
	) {
		throw new Error("scaleInCooldownMs must be a non-negative integer");
	}
}

function validateMetrics(metrics: ConversationQueueMetrics): void {
	for (const [name, value] of Object.entries(metrics)) {
		if (!Number.isInteger(value) || value < 0) {
			throw new Error(`${name} must be a non-negative integer`);
		}
	}
}

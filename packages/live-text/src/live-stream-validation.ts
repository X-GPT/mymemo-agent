export const LIVE_STREAM_RUN_ID_MAX_LENGTH = 128;
export const LIVE_STREAM_DEPLOYMENT_MAX_LENGTH = 64;
export const LIVE_STREAM_PATH_SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/;

export function validateLiveStreamRunId(
	value: string,
	name: "runId" | "streamId" | "retryId",
): void {
	if (
		value.length < 1 ||
		value.length > LIVE_STREAM_RUN_ID_MAX_LENGTH ||
		!LIVE_STREAM_PATH_SAFE_IDENTIFIER_PATTERN.test(value)
	) {
		const qualifier = name === "retryId" ? "" : " Run";
		throw new Error(`${name} must be a path-safe${qualifier} identifier`);
	}
}

export function validateLiveStreamDeployment(deployment: string): void {
	if (
		deployment.length < 1 ||
		deployment.length > LIVE_STREAM_DEPLOYMENT_MAX_LENGTH ||
		!LIVE_STREAM_PATH_SAFE_IDENTIFIER_PATTERN.test(deployment)
	) {
		throw new Error("deployment must be a path-safe identifier");
	}
}

export function requirePositiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error(`${name} must be a positive integer`);
	}
	return value;
}

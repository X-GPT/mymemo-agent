export const LIVE_STREAM_RUN_ID_MAX_LENGTH = 128;
export const LIVE_STREAM_DEPLOYMENT_MAX_LENGTH = 64;
export const LIVE_STREAM_PATH_SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]+$/;

export const LIVE_STREAM_TURN_ID_MAX_LENGTH = 128;

function validatePathSafeIdentifier(
	value: string,
	maxLength: number,
	message: string,
): void {
	if (
		value.length < 1 ||
		value.length > maxLength ||
		!LIVE_STREAM_PATH_SAFE_IDENTIFIER_PATTERN.test(value)
	) {
		throw new Error(message);
	}
}

export function validateLiveStreamRunId(value: string): void {
	validatePathSafeIdentifier(
		value,
		LIVE_STREAM_RUN_ID_MAX_LENGTH,
		"runId must be a path-safe Run identifier",
	);
}

export function validateLiveStreamTurnId(value: string): void {
	validatePathSafeIdentifier(
		value,
		LIVE_STREAM_TURN_ID_MAX_LENGTH,
		"turnId must be a path-safe Turn identifier",
	);
}

export function validateLiveStreamDeployment(deployment: string): void {
	validatePathSafeIdentifier(
		deployment,
		LIVE_STREAM_DEPLOYMENT_MAX_LENGTH,
		"deployment must be a path-safe identifier",
	);
}

export function requirePositiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error(`${name} must be a positive integer`);
	}
	return value;
}

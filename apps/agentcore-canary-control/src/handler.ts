import { createDatabase } from "@mymemo/agent-db/client";
import {
	type CanaryControlConfig,
	createCanaryControl,
	parseCanaryStartRequest,
} from "./control";
import { createCanaryFixtureDb, createCanaryFixtureVerifier } from "./fixture";

type Env = Record<string, string | undefined>;

export interface CanaryControlHandlerConfig {
	agentDatabaseUrl: string;
	kbDatabaseUrl: string;
	approvedSyntheticUserId: string;
	control: CanaryControlConfig;
}

function requireEnv(env: Env, name: string): string {
	const value = env[name];
	if (!value || value.trim() === "") throw new Error(`${name} is required`);
	return value;
}

/** Deployment-only configuration. The operator invocation supplies none of it. */
export function loadCanaryControlHandlerConfigFromEnv(
	env: Env,
): CanaryControlHandlerConfig {
	const rawControl = requireEnv(env, "CANARY_CONTROL_CONFIG_JSON");
	let control: unknown;
	try {
		control = JSON.parse(rawControl);
	} catch {
		throw new Error("CANARY_CONTROL_CONFIG_JSON must be valid JSON");
	}
	if (
		typeof control !== "object" ||
		control === null ||
		Array.isArray(control)
	) {
		throw new Error("CANARY_CONTROL_CONFIG_JSON must be an object");
	}

	return {
		agentDatabaseUrl: requireEnv(env, "AGENT_DATABASE_URL"),
		kbDatabaseUrl: requireEnv(env, "KB_DATABASE_URL"),
		approvedSyntheticUserId: requireEnv(
			env,
			"CANARY_APPROVED_SYNTHETIC_USER_ID",
		),
		control: control as CanaryControlConfig,
	};
}

export function createCanaryControlHandler(control: {
	start(rawRequest: unknown): Promise<unknown>;
}) {
	return async (event: unknown) => {
		// Parse at the Lambda boundary so wrappers cannot accidentally widen the
		// two-field operator contract before the control service sees it.
		const request = parseCanaryStartRequest(event);
		return await control.start(request);
	};
}

function createProductionHandler(env: Env) {
	const config = loadCanaryControlHandlerConfigFromEnv(env);
	const db = createDatabase(config.agentDatabaseUrl);
	const fixtureDb = createCanaryFixtureDb(config.kbDatabaseUrl);
	const verifier = createCanaryFixtureVerifier(fixtureDb, {
		approvedSyntheticUserId: config.approvedSyntheticUserId,
	});
	return createCanaryControlHandler(
		createCanaryControl({ db, config: config.control, verifier }),
	);
}

let productionHandler:
	| ReturnType<typeof createCanaryControlHandler>
	| undefined;

/** Operator-only Lambda entrypoint; it is not mounted on chat-api. */
export async function handler(event: unknown) {
	productionHandler ??= createProductionHandler(process.env);
	return await productionHandler(event);
}

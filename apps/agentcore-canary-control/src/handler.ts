import { createDatabase } from "@mymemo/agent-db/client";
import {
	createCanaryDispatchProductionPublisher,
	loadCanaryDispatchPublisherConfigFromEnv,
} from "agentcore-canary-dispatch/production";
import { z } from "zod";
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

const nonEmptyString = z.string().trim().min(1);
const controlConfigSchema = z.strictObject({
	campaignVersion: nonEmptyString,
	fixture: z.strictObject({
		version: nonEmptyString,
		checksum: nonEmptyString,
		identity: z.strictObject({
			kind: z.literal("non_human"),
			userId: nonEmptyString,
		}),
		collectionId: nonEmptyString,
		documents: z.array(
			z.strictObject({
				documentId: nonEmptyString,
				version: z.number().int().positive(),
				contentSha256: nonEmptyString,
			}),
		),
	}),
	scenario: z.strictObject({
		id: nonEmptyString,
		prompt: nonEmptyString,
		model: nonEmptyString,
	}),
}) satisfies z.ZodType<CanaryControlConfig>;

function parseControlConfig(value: unknown): CanaryControlConfig {
	const parsed = controlConfigSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error("CANARY_CONTROL_CONFIG_JSON is invalid");
	}
	return parsed.data;
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

	return {
		agentDatabaseUrl: requireEnv(env, "AGENT_DATABASE_URL"),
		kbDatabaseUrl: requireEnv(env, "KB_DATABASE_URL"),
		approvedSyntheticUserId: requireEnv(
			env,
			"CANARY_APPROVED_SYNTHETIC_USER_ID",
		),
		control: parseControlConfig(control),
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
	const publish = createCanaryDispatchProductionPublisher(
		loadCanaryDispatchPublisherConfigFromEnv(env),
	);
	const fixtureDb = createCanaryFixtureDb(config.kbDatabaseUrl);
	const verifier = createCanaryFixtureVerifier(fixtureDb, {
		approvedSyntheticUserId: config.approvedSyntheticUserId,
	});
	return createCanaryControlHandler(
		createCanaryControl({
			db,
			config: config.control,
			verifier,
			publisher: {
				publishPending: async () =>
					await publish(`control/${crypto.randomUUID()}`),
			},
		}),
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

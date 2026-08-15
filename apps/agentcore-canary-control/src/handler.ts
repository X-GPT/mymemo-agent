import { createDatabase } from "@mymemo/agent-db/client";
import { createCanaryDispatchProductionPublisher } from "agentcore-canary-dispatch/production";
import {
	type CurrentSecretReader,
	createAwsCurrentSecretReader,
	createRetryableAsyncSingleton,
	requireEnv,
	resolveCanaryDatabaseUrlsFromSecretArns,
} from "agentcore-canary-dispatch/secret-config";
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

export async function resolveCanaryControlHandlerConfigFromSecretArns(
	env: Env,
	readCurrentSecret: CurrentSecretReader,
): Promise<CanaryControlHandlerConfig> {
	const { agentDatabaseUrl, kbDatabaseUrl } =
		await resolveCanaryDatabaseUrlsFromSecretArns(env, readCurrentSecret);
	return loadCanaryControlHandlerConfigFromEnv({
		...env,
		AGENT_DATABASE_URL: agentDatabaseUrl,
		KB_DATABASE_URL: kbDatabaseUrl,
	});
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

async function createProductionHandler(env: Env) {
	const awsRegion = requireEnv(env, "AWS_REGION");
	const config = await resolveCanaryControlHandlerConfigFromSecretArns(
		env,
		createAwsCurrentSecretReader(awsRegion),
	);
	const db = createDatabase(config.agentDatabaseUrl);
	const publish = createCanaryDispatchProductionPublisher({
		agentDatabaseUrl: config.agentDatabaseUrl,
		awsRegion,
		queueUrl: requireEnv(env, "CANARY_DISPATCH_QUEUE_URL"),
		enabledParameterName: requireEnv(env, "CANARY_ENABLED_PARAMETER_NAME"),
	});
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

const productionHandler = createRetryableAsyncSingleton(() =>
	createProductionHandler(process.env),
);

/** Operator-only Lambda entrypoint; it is not mounted on chat-api. */
export async function handler(event: unknown) {
	return await (await productionHandler())(event);
}

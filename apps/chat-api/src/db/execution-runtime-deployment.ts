import { createDatabase } from "@mymemo/agent-db/client";
import {
	markFargateRuntimeAwareDeploymentReady,
	prepareFargateDeploymentCompatibility,
} from "@mymemo/agent-db/execution-runtime-deployment";
import { resolveDatabaseUrl } from "@/config/env";

const databaseUrl = resolveDatabaseUrl(
	Bun.env.AGENT_DATABASE_URL,
	Bun.env.DB_PASSWORD,
	Bun.env.DB_SSL,
);
if (!databaseUrl) {
	throw new Error(
		"AGENT_DATABASE_URL is required for the execution-runtime deployment assertion",
	);
}

const db = createDatabase(databaseUrl);
try {
	switch (Bun.env.EXECUTION_RUNTIME_DEPLOYMENT_ACTION) {
		case "prepare-fargate-deployment-compatibility": {
			const value = Bun.env.CANDIDATE_FARGATE_RUNTIME_AWARE;
			if (value !== "true" && value !== "false") {
				throw new Error(
					"CANDIDATE_FARGATE_RUNTIME_AWARE must be exactly true or false",
				);
			}
			await prepareFargateDeploymentCompatibility(db, {
				candidateRuntimeAware: value === "true",
			});
			console.log("Fargate execution-runtime compatibility preflight passed");
			break;
		}
		case "mark-fargate-runtime-aware":
			await markFargateRuntimeAwareDeploymentReady(db);
			console.log("Fargate execution-runtime-aware rollout recorded");
			break;
		default:
			throw new Error(
				"EXECUTION_RUNTIME_DEPLOYMENT_ACTION must be prepare-fargate-deployment-compatibility or mark-fargate-runtime-aware",
			);
	}
} finally {
	await db.$client.end();
}

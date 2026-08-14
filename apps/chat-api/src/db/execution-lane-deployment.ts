import {
	assertFargateRollbackAllowed,
	createDatabase,
	markFargateLaneAwareDeploymentReady,
} from "@mymemo/agent-db";
import { resolveDatabaseUrl } from "@/config/env";

const databaseUrl = resolveDatabaseUrl(
	Bun.env.AGENT_DATABASE_URL,
	Bun.env.DB_PASSWORD,
	Bun.env.DB_SSL,
);
if (!databaseUrl) {
	throw new Error(
		"AGENT_DATABASE_URL is required for the execution-lane deployment assertion",
	);
}

const db = createDatabase(databaseUrl);
try {
	switch (Bun.env.EXECUTION_LANE_DEPLOYMENT_ACTION) {
		case "prepare-fargate-deployment": {
			const value = Bun.env.CANDIDATE_FARGATE_LANE_AWARE;
			if (value !== "true" && value !== "false") {
				throw new Error(
					"CANDIDATE_FARGATE_LANE_AWARE must be exactly true or false",
				);
			}
			await assertFargateRollbackAllowed(db, {
				candidateLaneAware: value === "true",
			});
			console.log("Fargate execution-lane deployment preflight passed");
			break;
		}
		case "mark-fargate-lane-aware":
			await markFargateLaneAwareDeploymentReady(db);
			console.log("Fargate execution-lane-aware rollout recorded");
			break;
		default:
			throw new Error(
				"EXECUTION_LANE_DEPLOYMENT_ACTION must be prepare-fargate-deployment or mark-fargate-lane-aware",
			);
	}
} finally {
	await db.$client.end();
}

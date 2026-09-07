import assert from "node:assert/strict";
import { Sha256 } from "@aws-crypto/sha256-js";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { fromIni } from "@aws-sdk/credential-providers";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { SignatureV4 } from "@smithy/signature-v4";
import { createProxy } from "../../../scripts/front-proxy";

const base = new URL(process.env.FRONT_FUNCTION_URL ?? "");
const bucket = process.env.WORKSPACE_BUCKET;
const table = process.env.CONVERSATION_TABLE;
assert(bucket && table, "WORKSPACE_BUCKET and CONVERSATION_TABLE are required");
const config = {
	region: "us-west-2",
	credentials: fromIni({ profile: "mymemo" }),
};
const s3 = new S3Client(config);
const db = DynamoDBDocumentClient.from(new DynamoDBClient(config));
const signed = createProxy(
	base,
	new SignatureV4({ ...config, service: "lambda", sha256: Sha256 }),
	{
		"x-member-code": process.env.FRONT_MEMBER_CODE ?? "codex-smoke",
		"x-partner-code": process.env.FRONT_PARTNER_CODE ?? "mymemo",
	},
	"http://localhost",
);
async function call(path: string, method = "GET", body?: object, status = 200) {
	const response = await signed(
		new Request(`http://localhost/v1/conversations${path}`, {
			method,
			headers: { "content-type": "application/json" },
			body: body ? JSON.stringify(body) : undefined,
		}),
	);
	assert.equal(
		response.status,
		status,
		`${method} ${path}: ${response.status}`,
	);
	return response;
}
const { conversationId: id } = (await (
	await call("", "POST", {}, 201)
).json()) as { conversationId: string };
console.log(`Conversation ${id}; started ${new Date().toISOString()}`);
const path = `/${id}`;
async function inventory() {
	const objects: Record<string, number> = {};
	for (const prefix of [
		`_workspace/${id}/`,
		`_artifacts/${id}/`,
		`_history/${id}/`,
		`_transcripts/${id}.jsonl`,
	]) {
		const result = await s3.send(
			new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }),
		);
		assert(
			!result.IsTruncated,
			"Demo inventory unexpectedly exceeds one S3 page",
		);
		objects[prefix] = result.KeyCount ?? 0;
	}
	const result = await db.send(
		new QueryCommand({
			TableName: table,
			KeyConditionExpression: "PK = :pk",
			ExpressionAttributeValues: { ":pk": `CONV#${id}` },
			ConsistentRead: true,
		}),
	);
	assert(
		!result.LastEvaluatedKey,
		"Demo partition unexpectedly exceeds one DynamoDB page",
	);
	return { objects, items: result.Items ?? [] };
}
try {
	for (const turn of [1, 2]) {
		const response = await call(`${path}/messages`, "POST", {
			requestId: crypto.randomUUID(),
			text:
				turn === 1
					? "Use hand bash to run mkdir -p artifacts && printf 'Deletion demo Turn 1\\n' > artifacts/deletion-demo.txt && sleep 8. Then reply done."
					: "Use hand bash to append 'Deletion demo Turn 2' to artifacts/deletion-demo.txt. Then reply done.",
		});
		const stream = response.text();
		if (turn === 1) {
			await call(path, "DELETE", undefined, 409);
			console.log("PASS: DELETE during processing returned 409");
		}
		const text = await stream;
		assert(
			text.includes('"type":"finish"') && !text.includes('"type":"error"'),
			`Turn ${turn} failed`,
		);
		console.log(`PASS: Turn ${turn} finished`);
	}
	const before = await inventory();
	assert.equal(before.items.find((item) => item.SK === "META")?.turnCount, 2);
	assert(
		Object.values(before.objects).every((count) => count > 0),
		"All four S3 namespaces must contain real Turn data",
	);
	console.log(
		`Before deletion: ${JSON.stringify({ objects: before.objects, dynamoItems: before.items.length })}`,
	);
	const { artifacts } = (await (await call(`${path}/artifacts`)).json()) as {
		artifacts: { artifactId: string }[];
	};
	const artifact = artifacts[0];
	assert(artifact, "Turns must publish an artifact");
	const downloadPath = `${path}/artifacts/${artifact.artifactId}/download-url`;
	const downloadRequestedAt = Date.now();
	const { downloadUrl } = (await (await call(downloadPath)).json()) as {
		downloadUrl: string;
	};
	const download = await fetch(downloadUrl);
	assert.equal(download.status, 200);
	const artifactText = await download.text();
	assert(artifactText.includes("Deletion demo Turn 1"));
	assert(artifactText.includes("Deletion demo Turn 2"));
	console.log(
		"PASS: previously issued artifact URL returned 200 with both Turns' content",
	);
	await call(path, "DELETE", undefined, 204);
	const deletedAt = Date.now();
	console.log(`Deleted at ${new Date(deletedAt).toISOString()}`);
	for (const [route, method, body] of [
		[path, "DELETE", undefined],
		[path, "PATCH", { title: "deleted" }],
		[`${path}/messages`, "GET", undefined],
		[
			`${path}/messages`,
			"POST",
			{ text: "deleted", requestId: crypto.randomUUID() },
		],
		[`${path}/artifacts`, "GET", undefined],
		[downloadPath, "GET", undefined],
	] as const)
		await call(route, method, body, 404);
	console.log("PASS: all six Conversation routes returned 404 immediately");
	let urlRevoked = false;
	for (;;) {
		if (!urlRevoked) {
			const response = await fetch(downloadUrl);
			await response.body?.cancel();
			urlRevoked = response.status === 403 || response.status === 404;
			const urlAge = Date.now() - downloadRequestedAt;
			assert(
				urlAge <= 300_000,
				"URL invalidation was not observed within five minutes of issuance",
			);
			if (urlRevoked)
				console.log(
					`PASS: old artifact URL returned ${response.status} at age ${urlAge} ms`,
				);
		}
		const remaining = await inventory();
		const elapsed = Date.now() - deletedAt;
		const empty =
			remaining.items.length === 0 &&
			Object.values(remaining.objects).every((count) => count === 0);
		if (empty && urlRevoked) {
			assert(elapsed <= 600_000, "Cleanup exceeded ten minutes");
			console.log(
				`PASS: automatic Scheduler cleanup at ${elapsed} ms: ${JSON.stringify({ objects: remaining.objects, dynamoItems: remaining.items.length })}`,
			);
			break;
		}
		assert(
			elapsed < 600_000,
			"Automatic cleanup did not complete within ten minutes",
		);
		await Bun.sleep(1_000);
	}
} finally {
	// Only this script's fixture; never invoke the sweeper manually.
	const response = await signed(
		new Request(`http://localhost/v1/conversations${path}`, {
			method: "DELETE",
		}),
	);
	if (![204, 404].includes(response.status))
		console.error(
			`Fixture cleanup requires retry: DELETE ${path} returned ${response.status}`,
		);
	s3.destroy();
	db.destroy();
}

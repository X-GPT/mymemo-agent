import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import {
	CreateBucketCommand,
	DeleteObjectCommand,
	HeadObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { createHand, invokeHand } from "../../agent-runtime/src/hand";
import { Workspace } from "../src/workspace";

// Use the MCP version bundled with the pinned SDK, as the Runtime does.
const runtimeRequire = createRequire(
	new URL("../../agent-runtime/package.json", import.meta.url),
);
const sdkRequire = createRequire(runtimeRequire.resolve("claude-agent-sdk"));
const { Client } = sdkRequire("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = sdkRequire(
	"@modelcontextprotocol/sdk/inMemory.js",
);
const interpreterId = process.env.CODE_INTERPRETER_ID;
if (!interpreterId) throw new Error("CODE_INTERPRETER_ID is required");
const aws = new BedrockAgentCoreClient({});
const s3 = new S3Client({
	region: "us-west-2",
	endpoint: "http://127.0.0.1:9000",
	forcePathStyle: true,
	credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
});
const bucket = "mymemo-workspace-demo";
try {
	await s3.send(new CreateBucketCommand({ Bucket: bucket }));
} catch (error) {
	if (!(error instanceof Error && error.name === "BucketAlreadyOwnedByYou"))
		throw error;
}
const workspace = new Workspace(aws, interpreterId, s3, bucket);
const conversationId = crypto.randomUUID();
let digest = "";
console.log(`Conversation ${conversationId}`);
try {
	for (const turn of [1, 2]) {
		const session = await workspace.start(crypto.randomUUID());
		console.log(`Turn ${turn}: session ${session}`);
		try {
			await workspace.restore(conversationId, session);
			const server = createHand(
				invokeHand(interpreterId, session, new AbortController().signal),
				(error) => {
					throw error;
				},
			);
			const client = new Client({ name: "workspace-demo", version: "1" });
			const [clientTransport, serverTransport] =
				InMemoryTransport.createLinkedPair();
			await server.instance.connect(serverTransport);
			await client.connect(clientTransport);
			try {
				if (turn === 1) {
					const write = await client.callTool({
						name: "write",
						arguments: {
							file_path: "/ws/notes.txt",
							content: "Written in Turn 1\n",
						},
					});
					assert(!write.isError, JSON.stringify(write));
					const bash = await client.callTool({
						name: "bash",
						arguments: {
							command:
								'python3 -c \'import csv; f=open("data.csv","w"); w=csv.writer(f); w.writerow(["name","value"]); w.writerow(["demo",42]); f.close()\'',
						},
					});
					assert(!bash.isError, JSON.stringify(bash));
					const probe = await client.callTool({
						name: "bash",
						arguments: {
							command: `python3 -c 'import os,hashlib; data=os.urandom(9*1024*1024); open("multipart.bin","wb").write(data); print(hashlib.sha256(data).hexdigest())'`,
						},
					});
					assert(!probe.isError, JSON.stringify(probe));
					digest = JSON.parse(probe.content[0].text).value.trim();
					assert.match(digest, /^[a-f0-9]{64}$/);
				} else {
					const bash = await client.callTool({
						name: "bash",
						arguments: { command: "cat notes.txt data.csv" },
					});
					assert(!bash.isError, JSON.stringify(bash));
					const output = JSON.parse(bash.content[0].text);
					assert.equal(
						output.value.replaceAll("\r\n", "\n"),
						"Written in Turn 1\nname,value\ndemo,42\n",
					);
					console.log(output.value);
					const probe = await client.callTool({
						name: "bash",
						arguments: { command: "sha256sum multipart.bin" },
					});
					assert(!probe.isError, JSON.stringify(probe));
					assert.equal(
						JSON.parse(probe.content[0].text).value.split(" ")[0],
						digest,
					);
					console.log(`9 MiB multipart binary SHA-256 matched: ${digest}`);
				}
				await workspace.save(conversationId, session);
				const archive = await s3.send(
					new HeadObjectCommand({
						Bucket: bucket,
						Key: `_workspace/${conversationId}/workspace.tgz`,
					}),
				);
				assert((archive.ContentLength ?? 0) > 8 * 1024 * 1024);
				console.log(
					`Turn ${turn}: archive ${archive.ContentLength} bytes (multipart)`,
				);
			} finally {
				await client.close();
				await server.instance.close();
			}
		} finally {
			await workspace.stop(session);
			console.log(`Turn ${turn}: session stopped`);
		}
	}
	console.log(
		"PASS: real hand tools and workspace archive survived two sandbox sessions",
	);
} finally {
	await s3.send(
		new DeleteObjectCommand({
			Bucket: bucket,
			Key: `_workspace/${conversationId}/workspace.tgz`,
		}),
	);
	s3.destroy();
	aws.destroy();
}

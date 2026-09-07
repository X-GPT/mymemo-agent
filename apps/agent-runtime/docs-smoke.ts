// Real KB reads and an ephemeral Code Interpreter session; no model or KB writes.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
	BedrockAgentCoreClient,
	StartCodeInterpreterSessionCommand,
	StopCodeInterpreterSessionCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import {
	createKbDb,
	createScopedDocumentClient,
} from "@mymemo/document-tools/client";
import { readKbDatabaseUrl } from "./src/config";
import { createDocs } from "./src/docs";
import { createHand, invokeHand } from "./src/hand";

const require = createRequire(import.meta.url);
const sdkRequire = createRequire(require.resolve("claude-agent-sdk"));
const { Client } = sdkRequire("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = sdkRequire(
	"@modelcontextprotocol/sdk/inMemory.js",
);

async function connect(server: ReturnType<typeof createDocs>) {
	const client = new Client({ name: "docs-smoke", version: "1" });
	const [left, right] = InMemoryTransport.createLinkedPair();
	await server.instance.connect(left);
	await client.connect(right);
	return client;
}

async function call(
	client: Awaited<ReturnType<typeof connect>>,
	name: string,
	args: object,
) {
	const result = await client.callTool({ name, arguments: args });
	assert(!result.isError, `${name} returned an MCP error`);
	return JSON.parse(result.content[0].text);
}

let phase = "configuration";
async function smoke() {
	const identifier = process.env.CODE_INTERPRETER_ID;
	assert(identifier, "CODE_INTERPRETER_ID is required");
	const signal = AbortSignal.timeout(180_000);
	const kb = createKbDb(await readKbDatabaseUrl(process.env));
	phase = "KB read-only role validation";
	const [role] = await kb.query<{ readOnly: boolean }>(`SELECT
		NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
		AND NOT EXISTS (
			SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
			AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
			AND (has_table_privilege(c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')
				OR has_any_column_privilege(c.oid, 'INSERT, UPDATE'))
		) AS "readOnly"`);
	assert(role?.readOnly, "KB role has write privileges; refusing the smoke");
	phase = "KB discovery";
	// Discover existing, currently searchable documents with a literal searchable
	// English word present in both a passage and the loadable markdown excerpt.
	// ponytail: sample 20 mappings to stay under the KB timeout; widen if fixtures disappear.
	const candidates = await kb.query<{
		userId: string;
		summaryId: string;
		documentId: string;
		phrase: string;
	}>(`SELECT ca.member_code AS "userId", ca.compat_int_id::text AS "summaryId",
		d.id AS "documentId", word.phrase
		FROM (SELECT member_code, compat_int_id, kb_document_id FROM content_asset
			WHERE kb_document_id <> '' AND compat_int_id IS NOT NULL LIMIT 20) ca
		JOIN document mapped ON mapped.id = ca.kb_document_id
		JOIN LATERAL (
			SELECT current_doc.* FROM document current_doc
			JOIN source_asset sa ON sa.id = current_doc.source_asset_id
			WHERE current_doc.source_asset_id = mapped.source_asset_id
			AND current_doc.workspace_id = ca.member_code AND current_doc.status = 'active'
			AND sa.workspace_id = ca.member_code AND sa.status = 'ready'
			ORDER BY current_doc.version DESC, current_doc.id DESC LIMIT 1
		) d ON TRUE
		JOIN LATERAL (
			SELECT word.phrase FROM passage p
			CROSS JOIN LATERAL (SELECT (regexp_match(p.passage_text, '[A-Za-z]{5,}'))[1] AS phrase) word
			WHERE p.document_id = d.id AND p.workspace_id = ca.member_code AND p.status = 'active'
			AND word.phrase IS NOT NULL
			AND position(word.phrase IN left(d.canonical_markdown, 50000)) > 0
			AND p.search_tsv @@ plainto_tsquery('simple', word.phrase)
			LIMIT 1
		) word ON TRUE
		WHERE ca.compat_int_id IS NOT NULL
		LIMIT 100`);
	const target = candidates.find((row) =>
		candidates.some(
			(other) =>
				other.userId === row.userId && other.documentId !== row.documentId,
		),
	);
	assert(
		target,
		"Need two searchable mapped documents belonging to one KB user",
	);
	const outside = candidates.find(
		(row) =>
			row.userId === target.userId && row.documentId !== target.documentId,
	);
	assert(outside);
	const scoped = createScopedDocumentClient({
		kb,
		userId: target.userId,
		scope: { type: "document", summaryId: target.summaryId },
		logger: { info() {}, error() {} },
	});
	phase = "Code Interpreter session start";
	const aws = new BedrockAgentCoreClient({ region: process.env.AWS_REGION });
	const started = await aws.send(
		new StartCodeInterpreterSessionCommand({
			codeInterpreterIdentifier: identifier,
			name: "docs-smoke-740",
			sessionTimeoutSeconds: 300,
		}),
		{ abortSignal: signal },
	);
	assert(started.sessionId, "Code Interpreter did not return a session id");
	const clients: Awaited<ReturnType<typeof connect>>[] = [];
	try {
		const invoke = invokeHand(identifier, started.sessionId, signal);
		const hand = createHand(invoke, (error) => {
			throw error;
		});
		const handClient = await connect(hand);
		clients.push(handClient);
		const docsClient = await connect(createDocs(scoped, hand, signal));
		clients.push(docsClient);
		phase = "scoped list/search/load";
		const list = await call(docsClient, "ListDocuments", {});
		assert.equal(
			list.total,
			1,
			"Document scope should list exactly one current document",
		);
		assert.equal(list.documents[0]?.documentId, target.documentId);
		const search = await call(docsClient, "SearchDocuments", {
			query: target.phrase,
		});
		assert(
			search.passages.some(
				(row: { documentId: string }) => row.documentId === target.documentId,
			),
			"Scoped search did not find the known phrase",
		);
		const loaded = await call(docsClient, "LoadDocuments", {
			documentIds: [target.documentId],
		});
		assert.equal(loaded.errors.length, 0, "Load failed");
		assert.equal(loaded.loaded.length, 1);
		assert(!("content" in loaded.loaded[0]), "Load leaked a document body");
		assert.equal(
			loaded.loaded[0].path,
			`/ws/.mymemo/docs/${target.documentId}.md`,
		);
		phase = "sandbox Grep";
		const grep = await call(handClient, "grep", {
			pattern: target.phrase,
			path: loaded.loaded[0].path,
			output_mode: "content",
		});
		assert(
			grep.value.includes(target.phrase),
			"Grep did not find the phrase in the sandbox file",
		);
		phase = "outside-scope rejection";
		assert(
			list.documents.every(
				(row: { documentId: string }) => row.documentId !== outside.documentId,
			),
		);
		const outsideSearch = await call(docsClient, "SearchDocuments", {
			query: outside.phrase,
		});
		assert(
			outsideSearch.passages.every(
				(row: { documentId: string }) => row.documentId === target.documentId,
			),
			"Search exposed an outside-scope document",
		);
		const rejected = await call(docsClient, "LoadDocuments", {
			documentIds: [outside.documentId],
		});
		assert.equal(rejected.loaded.length, 0);
		assert.equal(rejected.errors.length, 1);
		console.log(
			"PASS: real KB scoped list/search/load, sandbox Grep, and outside-scope rejection",
		);
	} finally {
		await Promise.allSettled(clients.map((client) => client.close()));
		await aws.send(
			new StopCodeInterpreterSessionCommand({
				codeInterpreterIdentifier: identifier,
				sessionId: started.sessionId,
			}),
		);
	}
}

await smoke().catch((error) => {
	// Driver errors can contain credentials, SQL, and document text.
	console.error(
		`FAIL: ${phase} (${error instanceof Error ? error.name : "unknown error"})`,
	);
	process.exitCode = 1;
});

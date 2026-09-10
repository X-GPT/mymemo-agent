import assert from "node:assert/strict";

const base = process.env.FRONT_PROXY_URL ?? "http://127.0.0.1:3001";
async function call(path: string, method = "GET", body?: object, status = 200) {
	const response = await fetch(`${base}/v1/conversations${path}`, {
		method,
		headers: { "content-type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
	assert.equal(
		response.status,
		status,
		`${method} ${path}: ${await response.clone().text()}`,
	);
	return status === 204 ? undefined : response.json();
}

const created = await call("", "POST", {}, 201);
const path = `/${created.conversationId}`;
try {
	assert.equal(created.scope, "general");
	assert.equal(
		(await call(path, "PATCH", { title: "Front lifecycle smoke" })).title,
		"Front lifecycle smoke",
	);
	// GSI listing is eventually consistent.
	for (let attempt = 0; ; attempt++) {
		const page = await call("?search=Front%20lifecycle%20smoke");
		if (
			page.conversations.some(
				(c: { conversationId: string }) =>
					c.conversationId === created.conversationId,
			)
		)
			break;
		assert.ok(attempt < 20, "Conversation did not appear in listing/search");
		await Bun.sleep(500);
	}
	assert.deepEqual(await call(`${path}/messages`), {
		messages: [],
		nextCursor: null,
	});
	assert.deepEqual(await call(`${path}/artifacts`), { artifacts: [] });
	await call(`${path}/artifacts/missing/download-url`, "GET", undefined, 404);
	await call(`${path}/artifacts/missing/content`, "GET", undefined, 404);
	assert.ok((await call(path, "PATCH", { archived: true })).archivedAt);
	assert.equal(
		(await call(path, "PATCH", { archived: false })).archivedAt,
		null,
	);
} finally {
	await call(path, "DELETE", undefined, 204);
}
await call(`${path}/messages`, "GET", undefined, 404);
console.log(
	`PASS: create, list/search, rename, archive/unarchive, messages, artifacts, download-url, preview content and delete (${created.conversationId})`,
);

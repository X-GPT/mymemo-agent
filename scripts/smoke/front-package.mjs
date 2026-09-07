import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Run under Node.js 22 / Linux ARM64 against the extracted release zip.
// Stub only the AWS boundary; load the real Statsig native module and Hono.
assert.equal(process.platform, "linux");
assert.equal(process.arch, "arm64");
assert.equal(process.versions.node.split(".")[0], "22");
const entry = pathToFileURL(resolve(process.argv[2], "index.mjs"));
const require = createRequire(entry);
const { SecretsManagerClient } = require("@aws-sdk/client-secrets-manager");
SecretsManagerClient.prototype.send = async () => ({
	SecretString: "secret-test",
});
Object.assign(process.env, {
	AWS_REGION: "us-west-2",
	CONVERSATION_TABLE: "package-smoke",
	WORKSPACE_BUCKET: "package-smoke",
	AGENT_RUNTIME_ARN:
		"arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/package_smoke-0123456789",
	STATSIG_SERVER_SECRET_ARN:
		"arn:aws:secretsmanager:us-west-2:123456789012:secret:package-smoke",
});
globalThis.awslambda = { streamifyResponse: (handler) => handler };
const { handler } = await import(entry.href);
assert.equal(typeof handler, "function");
console.log(
	"PASS: Node.js 22 ARM64 Lambda cold start, including Statsig native binding",
);

// The native SDK starts background initialization; this smoke check ends at load.
process.exit(0);

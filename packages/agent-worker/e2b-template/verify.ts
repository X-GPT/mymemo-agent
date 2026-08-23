// Task 9.2 acceptance check for file search and artifact publication tools.
//
//   E2B_API_KEY=... bun run template:verify [templateNameOrId]
//
// The template defaults to WORKER_E2B_TEMPLATE, then TEMPLATE_NAME — the same
// id a configured worker would provision run sandboxes from. Exits non-zero
// on any failure so the deploy flow's template build/verify stage can gate on
// it.
import { CommandExitError, Sandbox } from "e2b";
import { TEMPLATE_NAME } from "./template";

if (!process.env.E2B_API_KEY) {
	console.error("E2B_API_KEY is required to verify the template");
	process.exit(2);
}

const template =
	process.argv[2] ?? process.env.WORKER_E2B_TEMPLATE ?? TEMPLATE_NAME;

// Runtime dependencies for file search and descriptor-pinned artifact reads.
const checks = ["rg --version", "python3 --version"];

console.log(`creating sandbox from template ${template} ...`);
const sandbox = await Sandbox.create(template, {
	timeoutMs: 120_000,
	metadata: { purpose: "template-verify-9.2" },
});

let failed = false;
try {
	for (const command of checks) {
		try {
			// Default sandbox user, exactly as the run-time tools execute. The SDK
			// throws CommandExitError on a non-zero exit.
			const result = await sandbox.commands.run(command);
			console.log(`ok ${command}: ${result.stdout.split("\n")[0]}`);
		} catch (error) {
			if (!(error instanceof CommandExitError)) throw error;
			console.error(`FAIL ${command}: exit ${error.exitCode}`);
			console.error(error.stderr);
			failed = true;
		}
	}
} finally {
	await Sandbox.kill(sandbox.sandboxId).catch(() => {});
}

if (failed) process.exit(1);
console.log(`template ${template} verified`);

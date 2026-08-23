// Build (or rebuild) the custom sandbox template on E2B infrastructure.
//
//   E2B_API_KEY=... bun run template:build [name]
//
// `name` defaults to TEMPLATE_NAME; pass an override to build a side-by-side
// candidate (e.g. `mymemo-agent-sandbox:next`) without touching the alias
// the Runtime points at. Follow with `bun run template:verify [name]`.
import { defaultBuildLogger, Template } from "e2b";
import { sandboxTemplate, TEMPLATE_NAME } from "./template";

if (!process.env.E2B_API_KEY) {
	console.error("E2B_API_KEY is required to build the template");
	process.exit(2);
}

const name = process.argv[2] ?? TEMPLATE_NAME;

console.log(`building E2B template ${name} ...`);
const info = await Template.build(sandboxTemplate(), name, {
	onBuildLogs: defaultBuildLogger(),
});
console.log(`built E2B template ${name}:`, JSON.stringify(info));

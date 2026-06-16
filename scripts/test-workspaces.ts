#!/usr/bin/env bun
// Runs each workspace's `test` script in its own process, serially.
//
// Separate processes give env/module isolation: packages set conflicting test
// env (e.g. chat-api wants LLM_TOKEN_SECRET="test-llm-token-secret", gateway
// wants "test-secret") and freeze module-load config, so a single shared
// `bun test` over the whole tree leaks state across packages. Serial execution
// additionally keeps wall-clock timing tests (sandbox-daemon's idle timers)
// stable under load.
//
// Discovery is by the presence of a `test` script in a workspace's
// package.json, so a new package opts in just by declaring one — no list to
// keep in sync here.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WORKSPACE_GROUPS = ["packages", "apps"];
const root = process.cwd();

const targets: string[] = [];
for (const group of WORKSPACE_GROUPS) {
	const groupDir = join(root, group);
	if (!existsSync(groupDir)) continue;
	for (const name of readdirSync(groupDir).sort()) {
		const dir = join(group, name);
		const pkgPath = join(root, dir, "package.json");
		if (!existsSync(pkgPath)) continue;
		let pkg: { scripts?: Record<string, string> };
		try {
			pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
		} catch (err) {
			console.error(
				`Invalid package.json at ${pkgPath}: ${(err as Error).message}`,
			);
			process.exit(1);
		}
		if (pkg.scripts?.test) targets.push(dir);
	}
}

if (targets.length === 0) {
	// This repo always has test-bearing workspaces, so zero means discovery
	// broke (wrong cwd, renamed dirs) — fail loudly rather than pass silently.
	console.error(
		"No workspaces with a `test` script found — discovery is broken.",
	);
	process.exit(1);
}

console.log(`Testing ${targets.length} workspaces:\n  ${targets.join("\n  ")}`);

for (const dir of targets) {
	console.log(`\n=== ${dir} ===`);
	const res = spawnSync(process.execPath, ["run", "test"], {
		cwd: join(root, dir),
		stdio: "inherit",
	});
	if (res.status !== 0) {
		console.error(`\n✗ Tests failed in ${dir}`);
		process.exit(res.status ?? 1);
	}
}

console.log("\n✓ All workspace tests passed");

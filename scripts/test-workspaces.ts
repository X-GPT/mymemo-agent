#!/usr/bin/env bun
// Runs each workspace's `test` script in its own process, serially.
//
// Separate processes give env/module isolation: packages set conflicting test
// env (e.g. chat-api's STATSIG_SERVER_SECRET vs the worker's OpenRouter/KB vars)
// and freeze module-load config, so a single shared `bun test` over the whole
// tree leaks state across packages. Serial execution additionally keeps
// wall-clock timing tests (the worker's heartbeat/lease timers) stable under load.
//
// Discovery is by the presence of a `test` script in a workspace's
// package.json, so a new package opts in just by declaring one — no list to
// keep in sync here.
import { spawnSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.cwd();

const targets: string[] = [];
for (const pkgPath of globSync("{apps,packages}/*/package.json", {
	cwd: root,
}).sort()) {
	let pkg: { scripts?: Record<string, string> };
	try {
		pkg = JSON.parse(readFileSync(join(root, pkgPath), "utf8"));
	} catch (err) {
		console.error(
			`Invalid package.json at ${pkgPath}: ${(err as Error).message}`,
		);
		process.exit(1);
	}
	if (pkg.scripts?.test) targets.push(dirname(pkgPath));
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

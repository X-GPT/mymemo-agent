import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function resolveWorkspaceImport(from: string, request: string): string | null {
	if (request.startsWith(".")) {
		const target = resolve(dirname(from), request);
		for (const candidate of [
			target,
			`${target}.ts`,
			join(target, "index.ts"),
		]) {
			if (existsSync(candidate)) return candidate;
		}
		return null;
	}
	try {
		return Bun.resolveSync(request, dirname(from));
	} catch {
		return null;
	}
}

export function workspaceImportGraph(
	root: string,
	entrypoint: string,
): Set<string> {
	const graph = new Set<string>();
	const pending = [entrypoint];
	const transpiler = new Bun.Transpiler({ loader: "ts" });
	while (pending.length > 0) {
		const file = pending.pop();
		if (!file || graph.has(file)) continue;
		graph.add(file);
		for (const imported of transpiler.scanImports(readFileSync(file, "utf8"))) {
			const resolved = resolveWorkspaceImport(file, imported.path);
			if (
				resolved?.startsWith(`${root}/`) &&
				!resolved.includes("/node_modules/") &&
				/\.[cm]?[jt]sx?$/.test(resolved)
			) {
				pending.push(resolved);
			}
		}
	}
	return graph;
}

import { expect } from "bun:test";
import type { FileToolContext, FileToolResult } from "./file-tools";
import { runGlobFileTool, runGrepFileTool } from "./file-tools";

/**
 * The file-tools integration contract, shared by every real
 * `SandboxFileClient` substrate (the local-command integration test and the
 * live E2B file-client test): seeded through the client itself, the
 * `rg`-backed Grep and `python3`-backed Glob return bounded, sorted,
 * hidden-filtered results that are identical across substrates.
 */
export async function runFileToolsContract(
	context: FileToolContext,
): Promise<void> {
	const root = context.workspaceRoot;
	await context.client.writeFile({
		path: `${root}/notes.txt`,
		content: "alpha\nbeta\n",
	});
	await context.client.writeFile({
		path: `${root}/src/memo.txt`,
		content: "alpha\n",
	});
	await context.client.writeFile({
		path: `${root}/.hidden.txt`,
		content: "alpha\n",
	});

	const grepResult = await runGrepFileTool(
		{ pattern: "alpha", maxResults: 10 },
		context,
	);
	expect(grepResult.isError).toBeUndefined();
	expect(parseToolResult(grepResult)).toEqual({
		matches: [
			{ path: "notes.txt", line: 1, column: 1, text: "alpha" },
			{ path: "src/memo.txt", line: 1, column: 1, text: "alpha" },
		],
		truncated: false,
	});

	const globResult = await runGlobFileTool(
		{ pattern: "**/*.txt", maxResults: 10 },
		context,
	);
	expect(globResult.isError).toBeUndefined();
	expect(parseToolResult(globResult)).toEqual({
		paths: ["notes.txt", "src/memo.txt"],
		truncated: false,
	});
}

/** Parse the JSON payload out of a file-tool result's text content. */
export function parseToolResult(result: FileToolResult): unknown {
	const [first] = result.content;
	if (!first) throw new Error("missing tool content");
	return JSON.parse(first.text);
}

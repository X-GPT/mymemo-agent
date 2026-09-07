import { posix } from "node:path";
import {
	BedrockAgentCoreClient,
	type CodeInterpreterResult,
	InvokeCodeInterpreterCommand,
	type ToolArguments,
	type ToolName,
} from "@aws-sdk/client-bedrock-agentcore";
import { createSdkMcpServer, tool } from "claude-agent-sdk";
import { z } from "zod";

export type HandInvoke = (
	name: ToolName,
	args: ToolArguments,
) => Promise<CodeInterpreterResult>;
const client = new BedrockAgentCoreClient({});
export function invokeHand(
	identifier: string,
	sessionId: string,
	signal: AbortSignal,
): HandInvoke {
	return async (name, args) => {
		const response = await client.send(
			new InvokeCodeInterpreterCommand({
				codeInterpreterIdentifier: identifier,
				sessionId,
				name,
				arguments: args,
			}),
			{ abortSignal: signal },
		);
		let result: CodeInterpreterResult | undefined;
		for await (const event of response.stream ?? []) {
			if (event.result) result = event.result;
			else {
				const [name, error] = Object.entries(event)[0] ?? [];
				throw Object.assign(new Error(error?.message ?? name), { name });
			}
		}
		if (!result) throw new Error("Empty Code Interpreter result");
		return result;
	};
}

export const toolAliases = Object.fromEntries(
	["Bash", "Read", "Write", "Edit", "Glob", "Grep"].map((name) => [
		name,
		`mcp__hand__${name.toLowerCase()}`,
	]),
);
export function workspacePath(path: string): string {
	if (
		!path ||
		path.includes("\0") ||
		path.split("/").includes("..") ||
		(path.startsWith("/") && path !== "/ws" && !path.startsWith("/ws/"))
	)
		throw new Error("Path must be within /ws; traversal is forbidden");
	return posix.join("ws", path.replace(/^\/ws\/?/, ""));
}
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
export function bounded(value: string) {
	const bytes = Buffer.from(value);
	return {
		value: new TextDecoder().decode(bytes.subarray(0, 65536), {
			stream: bytes.length > 65536,
		}),
		truncated: bytes.length > 65536,
		totalBytes: bytes.length,
	};
}
const integer = z.number().int().nonnegative();
export const handSchemas = {
	bash: {
		command: z.string(),
		timeout: z.number().int().positive().max(600000).optional(),
		description: z.string().optional(),
		run_in_background: z.literal(false).optional(),
		dangerouslyDisableSandbox: z.literal(false).optional(),
	},
	read: {
		file_path: z.string(),
		offset: z.number().int().positive().optional(),
		limit: z.number().int().positive().optional(),
		pages: z.string().optional(),
	},
	write: {
		file_path: z.string(),
		content: z
			.string()
			.refine(
				(text) => Buffer.byteLength(text) <= 1048576,
				"Write exceeds 1 MiB",
			),
	},
	edit: {
		file_path: z.string(),
		old_string: z.string().min(1),
		new_string: z.string(),
		replace_all: z.literal(false).optional(),
	},
	glob: { pattern: z.string(), path: z.string().optional() },
	grep: {
		pattern: z.string(),
		path: z.string().optional(),
		glob: z.string().optional(),
		output_mode: z.enum(["content", "files_with_matches", "count"]).optional(),
		"-B": integer.optional(),
		"-A": integer.optional(),
		"-C": integer.optional(),
		context: integer.optional(),
		"-n": z.boolean().optional(),
		"-i": z.boolean().optional(),
		"-o": z.boolean().optional(),
		type: z.string().optional(),
		head_limit: integer.optional(),
		offset: integer.optional(),
		multiline: z.boolean().optional(),
	},
};

export function createHand(invoke: HandInvoke, fatal: (error: Error) => void) {
	async function call(name: ToolName, args: ToolArguments) {
		try {
			const result = await invoke(name, args);
			if (result.isError) throw new Error(JSON.stringify(result.content));
			return result;
		} catch (error) {
			if (
				error instanceof Error &&
				(/resourcenotfoundexception/i.test(error.name) ||
					/(?:is |not )?not active/i.test(error.message))
			)
				fatal(error);
			throw error;
		}
	}
	async function command(command: string, timeout = 120000) {
		// Capture before crossing the AWS API response cap; a temporary file avoids unbounded RAM.
		const code = `import subprocess,tempfile,os,signal,json\nwith tempfile.TemporaryFile() as out:\n p=subprocess.Popen(${JSON.stringify(command)},shell=True,stdout=out,stderr=out,start_new_session=True)\n try: p.wait(timeout=${timeout / 1000})\n except subprocess.TimeoutExpired:\n  os.killpg(p.pid,signal.SIGKILL); p.wait()\n out.seek(0,2); size=out.tell(); out.seek(0)\n print(json.dumps(dict(value=out.read(65536).decode('utf-8','ignore'),truncated=size>65536,totalBytes=size,exitCode=p.returncode)))`;
		const result = await call("executeCommand", {
			command: `python3 -c ${quote(code)}`,
		});
		if (result.structuredContent?.exitCode)
			throw new Error(
				result.structuredContent.stderr || "Command wrapper failed",
			);
		return JSON.parse(result.structuredContent?.stdout ?? "") as ReturnType<
			typeof bounded
		> & { exitCode: number };
	}
	async function checkPath(path: string, parents = false) {
		const mapped = workspacePath(path);
		const code = `import pathlib\nr=pathlib.Path.home().resolve()/'ws'\np=pathlib.Path(${JSON.stringify(mapped)}).resolve()\nassert not r.is_symlink() and p.is_relative_to(r), 'Path escapes /ws'\n${parents ? "p.parent.mkdir(parents=True,exist_ok=True)" : ""}`;
		const result = await command(`python3 -c ${quote(code)}`);
		if (result.exitCode) throw new Error(result.value);
		return mapped;
	}
	async function read(path: string) {
		const mapped = await checkPath(path);
		const result = await call("readFiles", { paths: [mapped] });
		const resource = result.content?.find((block) => block.resource)?.resource;
		if (!resource) throw new Error("File response missing content");
		return resource;
	}
	async function write(path: string, content: string) {
		if (Buffer.byteLength(content) > 1048576)
			throw new Error("Write exceeds 1 MiB");
		const mapped = await checkPath(path, true);
		await call("writeFiles", { content: [{ path: mapped, text: content }] });
		return bounded(`Wrote ${Buffer.byteLength(content)} bytes to ${path}`);
	}
	const handlers = {
		bash: async (args: z.infer<z.ZodObject<typeof handSchemas.bash>>) =>
			command(`cd ~/ws && ${args.command}`, args.timeout),
		read: async (args: z.infer<z.ZodObject<typeof handSchemas.read>>) => {
			if (args.pages)
				throw new Error("PDF page extraction is unsupported; use Bash");
			const path = await checkPath(args.file_path);
			const start = (args.offset ?? 1) - 1;
			const end = args.limit ? start + args.limit : "None";
			const code = `import pathlib,mimetypes,itertools,json,sys,codecs\np=pathlib.Path(${JSON.stringify(path)})\nwith p.open('rb') as f:\n sample=f.read(8192)\n try: codecs.getincrementaldecoder('utf-8')().decode(sample,final=False) ; binary=b'\\0' in sample\n except UnicodeDecodeError: binary=True\n if binary: print(json.dumps(dict(sizeBytes=p.stat().st_size,mimeType=mimetypes.guess_type(str(p))[0] or 'application/octet-stream')))\n else:\n  f.seek(0)\n  for line in itertools.islice(f,${start},${end}): sys.stdout.buffer.write(line)`;
			return command(`python3 -c ${quote(code)}`);
		},
		write: async (args: z.infer<z.ZodObject<typeof handSchemas.write>>) =>
			write(args.file_path, args.content),
		edit: async (args: z.infer<z.ZodObject<typeof handSchemas.edit>>) => {
			const resource = await read(args.file_path);
			if (resource.text === undefined)
				throw new Error("Cannot edit binary file");
			const at = resource.text.indexOf(args.old_string);
			if (at < 0 || resource.text.indexOf(args.old_string, at + 1) >= 0)
				throw new Error("Edit requires exactly one match");
			return write(
				args.file_path,
				resource.text.slice(0, at) +
					args.new_string +
					resource.text.slice(at + args.old_string.length),
			);
		},
		glob: async (args: z.infer<z.ZodObject<typeof handSchemas.glob>>) => {
			const path = await checkPath(args.path ?? "/ws");
			const relative = path.slice(3);
			const prefix = relative.replace(/([*?[\]{}\\])/g, "\\$1");
			const pattern = `/${prefix ? `${prefix}/` : ""}${args.pattern}`;
			const result = await command(
				`cd ~/ws && rg --files --hidden --no-ignore --glob ${quote(pattern)} -- ${quote(relative || ".")}`,
			);
			if (![0, 1].includes(result.exitCode)) throw new Error(result.value);
			result.exitCode = 0;
			return result;
		},
		grep: async (args: z.infer<z.ZodObject<typeof handSchemas.grep>>) => {
			const path = await checkPath(args.path ?? "/ws");
			const flags = ["rg"];
			const content = args.output_mode === "content";
			if (!content) flags.push(args.output_mode === "count" ? "-c" : "-l");
			if (args["-i"]) flags.push("-i");
			if (args.multiline) flags.push("-U", "--multiline-dotall");
			if (args.glob) flags.push("--glob", args.glob);
			if (args.type) flags.push("--type", args.type);
			if (content) {
				if (args["-n"] !== false) flags.push("-n");
				if (args["-o"]) flags.push("-o");
				for (const flag of ["-A", "-B", "-C"] as const)
					if (args[flag] !== undefined) flags.push(flag, String(args[flag]));
				if (args.context !== undefined) flags.push("-C", String(args.context));
			}
			flags.push("--", args.pattern, path.slice(3) || ".");
			const result = await command(`cd ~/ws && ${flags.map(quote).join(" ")}`);
			if (![0, 1].includes(result.exitCode)) throw new Error(result.value);
			result.exitCode = 0;
			const start = args.offset ?? 0;
			const original = result.value;
			result.value = result.value
				.split("\n")
				.slice(
					start,
					args.head_limit === 0 ? undefined : start + (args.head_limit ?? 250),
				)
				.join("\n");
			result.truncated ||= original !== result.value;
			return result;
		},
	};
	function define<Shape extends z.ZodRawShape>(
		name: string,
		schema: Shape,
		handler: (
			args: z.infer<z.ZodObject<Shape>>,
		) => Promise<ReturnType<typeof bounded> & { exitCode?: number }>,
	) {
		return tool(
			name,
			`Run ${name} in the sandbox workspace /ws.`,
			schema,
			async (args) => {
				try {
					const parsed = z.strictObject(schema).parse(args);
					const output = await handler(parsed);
					return {
						content: [{ type: "text" as const, text: JSON.stringify(output) }],
						isError: !!output.exitCode,
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(
									bounded(
										error instanceof Error ? error.message : String(error),
									),
								),
							},
						],
						isError: true,
					};
				}
			},
		);
	}
	return createSdkMcpServer({
		name: "hand",
		alwaysLoad: true,
		tools: [
			define("bash", handSchemas.bash, handlers.bash),
			define("read", handSchemas.read, handlers.read),
			define("write", handSchemas.write, handlers.write),
			define("edit", handSchemas.edit, handlers.edit),
			define("glob", handSchemas.glob, handlers.glob),
			define("grep", handSchemas.grep, handlers.grep),
		],
	});
}

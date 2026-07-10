import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname } from "node:path";

interface ResolveOptions {
	paths?: string[];
}

interface ClaudeCodeExecutableOverrides {
	platform?: NodeJS.Platform;
	arch?: string;
	resolve?(request: string, options?: ResolveOptions): string;
	execFile?(executable: string, args: readonly string[]): void;
}

const require = createRequire(import.meta.url);

function defaultResolve(request: string, options?: ResolveOptions): string {
	return require.resolve(request, options);
}

function defaultExecFile(executable: string, args: readonly string[]): void {
	execFileSync(executable, [...args], { stdio: "ignore" });
}

function platformBinaryRequest(
	platform: NodeJS.Platform,
	arch: string,
): string {
	if (arch !== "x64" && arch !== "arm64") {
		throw new Error(`Unsupported Claude Code architecture: ${arch}`);
	}
	if (platform !== "linux" && platform !== "darwin" && platform !== "win32") {
		throw new Error(`Unsupported Claude Code platform: ${platform}`);
	}
	const extension = platform === "win32" ? ".exe" : "";
	return `@anthropic-ai/claude-agent-sdk-${platform}-${arch}/claude${extension}`;
}

/**
 * Resolve and exec-verify the SDK's native Claude Code binary before the worker
 * can claim a run. Resolution starts from the SDK package directory because
 * the native platform packages are its optional dependencies, not the
 * worker's. On Linux the package name deliberately omits `-musl`: the worker
 * image is Debian/glibc and the SDK's musl-first default cannot execute there.
 */
export function resolveAndVerifyClaudeCodeExecutable(
	overrides: ClaudeCodeExecutableOverrides = {},
): string {
	const resolve = overrides.resolve ?? defaultResolve;
	const execFile = overrides.execFile ?? defaultExecFile;
	const platform = overrides.platform ?? process.platform;
	const arch = overrides.arch ?? process.arch;

	let sdkEntry: string;
	try {
		sdkEntry = resolve("@anthropic-ai/claude-agent-sdk");
	} catch (cause) {
		throw new Error("Could not resolve the Claude Agent SDK at worker boot", {
			cause,
		});
	}

	const request = platformBinaryRequest(platform, arch);
	let executable: string;
	try {
		executable = resolve(request, { paths: [dirname(sdkEntry)] });
	} catch (cause) {
		throw new Error(
			`Could not resolve the Claude Code platform binary: ${request}`,
			{ cause },
		);
	}

	try {
		execFile(executable, ["--version"]);
	} catch (cause) {
		throw new Error(
			`Claude Code platform binary failed boot verification: ${executable}`,
			{ cause },
		);
	}
	return executable;
}

import type { CommandSandbox } from "../e2b/command-client";
import {
	type ArtifactManifestEntry,
	type ArtifactValidationCode,
	ArtifactValidationError,
	validateArtifactManifest,
} from "./artifact-manifest";
import type { ArtifactWorkspace } from "./artifact-publication";

export const ARTIFACT_ROOT = "/home/user/artifacts";

const MANIFEST_PROGRAM = `import json
import os
import stat
import sys

root = os.environ["MYMEMO_ARTIFACT_ROOT"]
entries = []

def fail(code):
    print(json.dumps({"artifactValidation": code}, separators=(",", ":")), file=sys.stderr)
    raise SystemExit(2)

if os.path.lexists(root):
    root_info = os.lstat(root)
    if not stat.S_ISDIR(root_info.st_mode) or stat.S_ISLNK(root_info.st_mode):
        fail("invalid_root")
    resolved_root = os.path.realpath(root)
    pending = [("", root)]
    while pending:
        relative_directory, directory = pending.pop()
        for entry in sorted(os.scandir(directory), key=lambda item: item.name):
            relative_path = entry.name if not relative_directory else relative_directory + "/" + entry.name
            info = entry.stat(follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode):
                fail("special_entry")
            resolved_path = os.path.realpath(entry.path)
            if os.path.commonpath((resolved_root, resolved_path)) != resolved_root:
                fail("outside_root")
            if stat.S_ISDIR(info.st_mode):
                pending.append((relative_path, entry.path))
            elif stat.S_ISREG(info.st_mode):
                entries.append({
                    "path": relative_path,
                    "sizeBytes": info.st_size,
                    "modifiedAt": str(info.st_mtime_ns),
                })
            else:
                fail("special_entry")
entries.sort(key=lambda entry: entry["path"])
print(json.dumps(entries, separators=(",", ":")))
`;

const MANIFEST_COMMAND = 'python3 -c "$MYMEMO_ARTIFACT_MANIFEST_PROGRAM"';

const PINNED_FILE_DESCRIPTOR = 3;
const PIN_READY_TIMEOUT_MS = 30_000;
const PIN_PROGRAM = `import json
import os
import signal
import stat
import sys

root = os.environ["MYMEMO_ARTIFACT_ROOT"]
relative_path = os.environ["MYMEMO_ARTIFACT_PATH"]
expected_size = int(os.environ["MYMEMO_ARTIFACT_SIZE"])
expected_mtime = os.environ["MYMEMO_ARTIFACT_MTIME"]
parent_fd = None
file_fd = None

def fail(code):
    print(json.dumps({"artifactValidation": code}, separators=(",", ":")), file=sys.stderr, flush=True)
    raise SystemExit(2)

try:
    root_info = os.lstat(root)
    if not stat.S_ISDIR(root_info.st_mode) or stat.S_ISLNK(root_info.st_mode):
        fail("invalid_root")
    parent_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    if not stat.S_ISDIR(os.fstat(parent_fd).st_mode):
        fail("invalid_root")
    components = relative_path.split("/")
    for component in components[:-1]:
        next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
        os.close(parent_fd)
        parent_fd = next_fd
    file_fd = os.open(components[-1], os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=parent_fd)
    os.close(parent_fd)
    parent_fd = None
    info = os.fstat(file_fd)
    if not stat.S_ISREG(info.st_mode):
        fail("special_entry")
    if info.st_size != expected_size or str(info.st_mtime_ns) != expected_mtime:
        fail("unstable_entry")
    if file_fd != ${PINNED_FILE_DESCRIPTOR}:
        os.dup2(file_fd, ${PINNED_FILE_DESCRIPTOR})
        os.close(file_fd)
        file_fd = ${PINNED_FILE_DESCRIPTOR}
    print("ready", flush=True)
    signal.pause()
except OSError:
    fail("special_entry")
finally:
    if parent_fd is not None:
        os.close(parent_fd)
    if file_fd is not None:
        os.close(file_fd)
`;
const PIN_COMMAND = 'exec python3 -c "$MYMEMO_ARTIFACT_PIN_PROGRAM"';

export interface ArtifactCommandHandle {
	readonly pid: number;
	wait(): Promise<unknown>;
	kill(): Promise<boolean>;
}

export interface ArtifactSandbox extends CommandSandbox {
	commands: CommandSandbox["commands"] & {
		run(
			cmd: string,
			opts: {
				background: true;
				envs: Record<string, string>;
				onStderr: (data: string) => void | Promise<void>;
				onStdout: (data: string) => void | Promise<void>;
				timeoutMs: number;
			},
		): Promise<ArtifactCommandHandle>;
	};
	files: {
		read(
			path: string,
			opts: { format: "stream" },
		): Promise<ReadableStream<Uint8Array>>;
	};
}

/** E2B-backed view of the reserved artifact root. */
export function createE2bArtifactWorkspace(
	sandbox: ArtifactSandbox,
): ArtifactWorkspace {
	return {
		async captureManifest(signal) {
			throwIfAborted(signal);
			const result = await sandbox.commands.run(MANIFEST_COMMAND, {
				envs: {
					MYMEMO_ARTIFACT_ROOT: ARTIFACT_ROOT,
					MYMEMO_ARTIFACT_MANIFEST_PROGRAM: MANIFEST_PROGRAM,
				},
				timeoutMs: 30_000,
			});
			throwIfAborted(signal);
			if (result.exitCode !== 0) {
				const code = parseValidationCode(result.stderr);
				if (code) throw new ArtifactValidationError(code);
				throw new Error("artifact manifest command failed");
			}
			return parseManifest(result.stdout);
		},
		async openFile(entry, signal) {
			return await openPinnedFile(sandbox, entry, signal);
		},
	};
}

async function openPinnedFile(
	sandbox: ArtifactSandbox,
	entry: ArtifactManifestEntry,
	signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
	throwIfAborted(signal);
	let stdout = "";
	let stderr = "";
	let readySettled = false;
	let settleReady!: (error?: Error) => void;
	const ready = new Promise<void>((resolve, reject) => {
		settleReady = (error) => {
			if (readySettled) return;
			readySettled = true;
			if (error) reject(error);
			else resolve();
		};
	});
	let handle: ArtifactCommandHandle;
	try {
		handle = await sandbox.commands.run(PIN_COMMAND, {
			background: true,
			envs: {
				MYMEMO_ARTIFACT_MTIME: entry.modifiedAt,
				MYMEMO_ARTIFACT_PATH: entry.path,
				MYMEMO_ARTIFACT_PIN_PROGRAM: PIN_PROGRAM,
				MYMEMO_ARTIFACT_ROOT: ARTIFACT_ROOT,
				MYMEMO_ARTIFACT_SIZE: String(entry.sizeBytes),
			},
			onStderr(data) {
				stderr = `${stderr}${data}`.slice(-256);
			},
			onStdout(data) {
				stdout += data;
				if (stdout === "ready\n") settleReady();
				else if (stdout.includes("\n") || stdout.length > 32) {
					settleReady(new Error("artifact file pin failed"));
				}
			},
			timeoutMs: 15 * 60_000,
		});
	} catch {
		throwIfAborted(signal);
		throw new Error("artifact file pin failed");
	}
	void handle.wait().then(
		() => settleReady(new Error("artifact file pin failed")),
		() => settleReady(new Error("artifact file pin failed")),
	);
	try {
		await waitUntilReady(ready, signal);
		const stream = await sandbox.files.read(
			`/proc/${handle.pid}/fd/${PINNED_FILE_DESCRIPTOR}`,
			{ format: "stream" },
		);
		if (signal.aborted) {
			await stream.cancel(signal.reason).catch(() => {});
			throwIfAborted(signal);
		}
		return streamWithCleanup(stream, () => handle.kill());
	} catch {
		await handle.kill().catch(() => false);
		throwIfAborted(signal);
		const code = parseValidationCode(stderr);
		if (code) throw new ArtifactValidationError(code);
		throw new Error("artifact file pin failed");
	}
}

async function waitUntilReady(
	ready: Promise<void>,
	signal: AbortSignal,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(
			() => finish(new Error("artifact file pin timed out")),
			PIN_READY_TIMEOUT_MS,
		);
		const onAbort = () =>
			finish(signal.reason ?? new Error("artifact workspace aborted"));
		const finish = (error?: unknown) => {
			clearTimeout(timeout);
			signal.removeEventListener("abort", onAbort);
			if (error !== undefined) reject(error);
			else resolve();
		};
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
		ready.then(() => finish(), finish);
	});
}

function streamWithCleanup(
	stream: ReadableStream<Uint8Array>,
	kill: () => Promise<boolean>,
): ReadableStream<Uint8Array> {
	const reader = stream.getReader();
	let cleaned = false;
	const cleanup = async () => {
		if (cleaned) return;
		cleaned = true;
		await kill().catch(() => false);
	};
	return new ReadableStream({
		async pull(controller) {
			try {
				const result = await reader.read();
				if (result.done) {
					await cleanup();
					controller.close();
				} else {
					controller.enqueue(result.value);
				}
			} catch (error) {
				await cleanup();
				controller.error(error);
			}
		},
		async cancel(reason) {
			await reader.cancel(reason).catch(() => {});
			await cleanup();
		},
	});
}

function parseManifest(raw: string) {
	try {
		return validateArtifactManifest(JSON.parse(raw));
	} catch (error) {
		if (error instanceof ArtifactValidationError) throw error;
		throw new ArtifactValidationError("invalid_manifest");
	}
}

const VALIDATION_CODES = new Set<ArtifactValidationCode>([
	"invalid_manifest",
	"invalid_path",
	"invalid_root",
	"outside_root",
	"special_entry",
	"unstable_entry",
]);

function parseValidationCode(stderr: string): ArtifactValidationCode | null {
	for (const line of stderr.trim().split(/\r?\n/).reverse()) {
		try {
			const parsed: unknown = JSON.parse(line);
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				"artifactValidation" in parsed &&
				typeof parsed.artifactValidation === "string" &&
				VALIDATION_CODES.has(
					parsed.artifactValidation as ArtifactValidationCode,
				)
			) {
				return parsed.artifactValidation as ArtifactValidationCode;
			}
		} catch {
			// Only an exact trusted validation record is accepted.
		}
	}
	return null;
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted)
		throw signal.reason ?? new Error("artifact workspace aborted");
}

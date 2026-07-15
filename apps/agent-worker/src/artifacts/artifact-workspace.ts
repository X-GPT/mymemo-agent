import type { FileSandbox } from "../e2b/file-client";
import type {
	ArtifactManifestEntry,
	ArtifactWorkspace,
} from "./artifact-publication";

export const ARTIFACT_ROOT = "/home/user/artifacts";

const MANIFEST_PROGRAM = `import json
import os
import stat

root = os.environ["MYMEMO_ARTIFACT_ROOT"]
entries = []
if os.path.isdir(root):
    for directory, directories, files in os.walk(root, followlinks=False):
        directories.sort()
        files.sort()
        for name in files:
            full_path = os.path.join(directory, name)
            info = os.lstat(full_path)
            if not stat.S_ISREG(info.st_mode):
                continue
            entries.append({
                "path": os.path.relpath(full_path, root).replace(os.sep, "/"),
                "sizeBytes": info.st_size,
                "modifiedAt": str(info.st_mtime_ns),
            })
print(json.dumps(entries, separators=(",", ":")))
`;

const MANIFEST_COMMAND = 'python3 -c "$MYMEMO_ARTIFACT_MANIFEST_PROGRAM"';

export type ArtifactSandbox = FileSandbox;

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
				throw new Error("artifact manifest command failed");
			}
			return parseManifest(result.stdout);
		},
		async readFile(path, signal) {
			throwIfAborted(signal);
			const bytes = await sandbox.files.read(`${ARTIFACT_ROOT}/${path}`, {
				format: "bytes",
			});
			throwIfAborted(signal);
			return bytes;
		},
	};
}

function parseManifest(raw: string): ArtifactManifestEntry[] {
	const parsed: unknown = JSON.parse(raw);
	if (!Array.isArray(parsed))
		throw new Error("artifact manifest is not an array");
	return parsed.map((entry) => {
		if (
			typeof entry !== "object" ||
			entry === null ||
			!("path" in entry) ||
			typeof entry.path !== "string" ||
			!("sizeBytes" in entry) ||
			typeof entry.sizeBytes !== "number" ||
			!("modifiedAt" in entry) ||
			typeof entry.modifiedAt !== "string"
		) {
			throw new Error("artifact manifest contains an invalid entry");
		}
		return {
			path: entry.path,
			sizeBytes: entry.sizeBytes,
			modifiedAt: entry.modifiedAt,
		};
	});
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted)
		throw signal.reason ?? new Error("artifact workspace aborted");
}

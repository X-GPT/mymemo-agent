import { posix } from "node:path";

export const MAX_ARTIFACT_PATH_BYTES = 1_024;

export interface ArtifactManifestEntry {
	path: string;
	sizeBytes: number;
	modifiedAt: string;
}

export type ArtifactValidationCode =
	| "invalid_manifest"
	| "invalid_path"
	| "invalid_root"
	| "outside_root"
	| "special_entry"
	| "unstable_entry";

/** Safe, bounded validation detail suitable for structured Runtime logs. */
export class ArtifactValidationError extends Error {
	override readonly name = "ArtifactValidationError";

	constructor(readonly code: ArtifactValidationCode) {
		super(`artifact validation failed: ${code}`);
	}
}

export function validateArtifactManifest(
	manifest: unknown,
): ArtifactManifestEntry[] {
	if (!Array.isArray(manifest)) {
		throw new ArtifactValidationError("invalid_manifest");
	}
	const paths = new Set<string>();
	return manifest.map((entry) => {
		if (
			typeof entry !== "object" ||
			entry === null ||
			!("path" in entry) ||
			typeof entry.path !== "string" ||
			!("sizeBytes" in entry) ||
			typeof entry.sizeBytes !== "number" ||
			!Number.isSafeInteger(entry.sizeBytes) ||
			entry.sizeBytes < 0 ||
			!("modifiedAt" in entry) ||
			typeof entry.modifiedAt !== "string" ||
			!/^\d+$/.test(entry.modifiedAt)
		) {
			throw new ArtifactValidationError("invalid_manifest");
		}
		validateArtifactPath(entry.path);
		if (paths.has(entry.path)) {
			throw new ArtifactValidationError("invalid_manifest");
		}
		paths.add(entry.path);
		return {
			path: entry.path,
			sizeBytes: entry.sizeBytes,
			modifiedAt: entry.modifiedAt,
		};
	});
}

export function validateArtifactPath(path: string): void {
	if (
		path.length === 0 ||
		posix.isAbsolute(path) ||
		posix.normalize(path) !== path ||
		path
			.split("/")
			.some(
				(segment) => segment === "" || segment === "." || segment === "..",
			) ||
		/\p{Cc}/u.test(path) ||
		!path.isWellFormed() ||
		new TextEncoder().encode(path).byteLength > MAX_ARTIFACT_PATH_BYTES
	) {
		throw new ArtifactValidationError("invalid_path");
	}
}

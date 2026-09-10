import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
	DeleteObjectCommand,
	GetObjectCommand,
	PutObjectCommand,
	type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { lookup } from "mime-types";
import { z } from "zod";
import type { Workspace } from "./workspace";

const MAX_BYTES = 100 * 1024 * 1024;
const PART_BYTES = 8 * 1024 * 1024;
/** ADR-0036: the sandboxed srcdoc preview lane, well under the 6 MB Lambda response cap. */
const PREVIEW_BYTES = 1024 * 1024;
const pathSchema = z
	.string()
	.min(1)
	.refine(
		(path) =>
			!path.startsWith("/") &&
			!path.includes("\\") &&
			!Array.from(path).some(
				(c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
			) &&
			!path.split("/").some((part) => part === ".." || part === "." || !part) &&
			path !== ".manifest.json" &&
			!path.startsWith(".manifest.json/"),
	);
const entrySchema = z.object({
	path: pathSchema,
	sizeBytes: z.number().int().min(0).max(MAX_BYTES),
	mtime: z.string().regex(/^\d+$/),
});
export interface Artifact {
	artifactId: string;
	path: string;
	sizeBytes: number;
	contentType: string;
	createdAt: string;
	updatedAt: string;
	/** Eligible for the ADR-0036 sandboxed inline preview. Derived, never stored. */
	previewable: boolean;
}
export interface ArtifactChanges {
	artifacts: Artifact[];
	removed: string[];
}
/** The stored manifest shape. `previewable` is derived on read, so old manifests keep working. */
type ManifestEntry = Omit<Artifact, "previewable"> & { mtime: string };
const prefix = (id: string) => `_artifacts/${id}/`;
const artifactId = (path: string) =>
	createHash("sha256").update(path).digest("base64url");
const previewable = (entry: Pick<ManifestEntry, "contentType" | "sizeBytes">) =>
	entry.contentType === "text/html" && entry.sizeBytes <= PREVIEW_BYTES;
const publicArtifact = ({
	mtime: _,
	...artifact
}: ManifestEntry): Artifact => ({
	...artifact,
	previewable: previewable(artifact),
});
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// No symlinks, including the root. Stat nanoseconds survive JSON round trips as strings.
const discover = `import os,stat,json
root=os.path.expanduser('~/ws/artifacts')
entries=[]
if os.path.isdir(root) and not os.path.islink(root):
 for directory,dirs,files in os.walk(root,followlinks=False):
  dirs[:]=[d for d in dirs if not os.path.islink(os.path.join(directory,d))]
  for name in files:
   file=os.path.join(directory,name)
   s=os.lstat(file)
   path=os.path.relpath(file,root)
   if stat.S_ISREG(s.st_mode) and s.st_size<=104857600 and path!='.manifest.json' and not path.startswith('.manifest.json/'):
    entries.append(dict(path=path,sizeBytes=s.st_size,mtime=str(s.st_mtime_ns)))
print(json.dumps(entries))`;

export class Artifacts {
	constructor(
		readonly s3: S3Client,
		readonly bucket: string,
	) {}

	async manifest(id: string): Promise<ManifestEntry[]> {
		try {
			const object = await this.s3.send(
				new GetObjectCommand({
					Bucket: this.bucket,
					Key: `${prefix(id)}.manifest.json`,
				}),
			);
			if (!object.Body) throw new Error("Artifact manifest body missing");
			return z
				.array(
					entrySchema.extend({
						artifactId: z.string(),
						contentType: z.string(),
						createdAt: z.string(),
						updatedAt: z.string(),
					}),
				)
				.parse(JSON.parse(await object.Body.transformToString()));
		} catch (error) {
			if (error instanceof Error && error.name === "NoSuchKey") return [];
			throw error;
		}
	}

	async list(id: string): Promise<Artifact[]> {
		return (await this.manifest(id))
			.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
			.map(publicArtifact);
	}

	async downloadUrl(id: string, requestedId: string) {
		const artifact = (await this.manifest(id)).find(
			(entry) => entry.artifactId === requestedId,
		);
		if (!artifact) return undefined;
		return getSignedUrl(
			this.s3,
			new GetObjectCommand({
				Bucket: this.bucket,
				Key: `${prefix(id)}${artifact.path}`,
				ResponseContentType: artifact.contentType,
				ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(posix.basename(artifact.path)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
			}),
			{ expiresIn: 300 },
		);
	}

	/**
	 * ADR-0036: the raw bytes of a previewable artifact, for the sandboxed srcdoc lane.
	 * Undefined for unknown and non-previewable artifacts alike, so the route cannot
	 * disclose which one it was. Read with GetObject; never presigned, never inline
	 * rendered by the front itself.
	 */
	async content(
		id: string,
		requestedId: string,
	): Promise<Uint8Array | undefined> {
		const artifact = (await this.manifest(id)).find(
			(entry) => entry.artifactId === requestedId,
		);
		if (!artifact || !previewable(artifact)) return undefined;
		const object = await this.s3.send(
			new GetObjectCommand({
				Bucket: this.bucket,
				Key: `${prefix(id)}${artifact.path}`,
			}),
		);
		if (!object.Body) throw new Error("Artifact body missing");
		return await object.Body.transformToByteArray();
	}

	async sync(
		id: string,
		sessionId: string,
		workspace: Pick<Workspace, "call" | "readParts">,
	): Promise<ArtifactChanges> {
		const previous = new Map(
			(await this.manifest(id)).map((entry) => [entry.path, entry]),
		);
		const result = await workspace.call(sessionId, "executeCommand", {
			command: `python3 -c ${quote(discover)}`,
		});
		const entries = z
			.array(entrySchema)
			.parse(JSON.parse(result.structuredContent?.stdout ?? ""));
		const manifest: ManifestEntry[] = [];
		const artifacts: Artifact[] = [];
		for (const entry of entries) {
			const old = previous.get(entry.path);
			previous.delete(entry.path);
			if (
				old &&
				old.sizeBytes === entry.sizeBytes &&
				old.mtime === entry.mtime
			) {
				manifest.push(old);
				continue;
			}
			const directory = `.artifact-export-${crypto.randomUUID()}`;
			const script = `import os,sys,stat
p=os.path.expanduser('~/ws/artifacts/'+sys.argv[1])
assert os.path.realpath(p)==p
with open(p,'rb') as f:
 s=os.fstat(f.fileno())
 assert stat.S_ISREG(s.st_mode) and s.st_size==${entry.sizeBytes} and str(s.st_mtime_ns)==${quote(entry.mtime)}
 os.mkdir(os.path.expanduser('~/'+sys.argv[2]))
 for i in range((s.st_size+8388607)//8388608):
  with open(os.path.expanduser('~/'+sys.argv[2]+'/part-'+str(i)),'wb') as out: out.write(f.read(8388608))
 assert os.fstat(f.fileno()).st_mtime_ns==s.st_mtime_ns`;
			await workspace.call(sessionId, "executeCommand", {
				command: `python3 -c ${quote(script)} ${quote(entry.path)} ${directory}`,
			});
			const paths = Array.from(
				{ length: Math.ceil(entry.sizeBytes / PART_BYTES) },
				(_, i) => `${directory}/part-${i}`,
			);
			const body = await workspace.readParts(sessionId, paths, entry.sizeBytes);
			const now = new Date().toISOString();
			const next: ManifestEntry = {
				...entry,
				artifactId: artifactId(entry.path),
				contentType: lookup(entry.path) || "application/octet-stream",
				createdAt: old?.createdAt ?? now,
				updatedAt: now,
			};
			await this.s3.send(
				new PutObjectCommand({
					Bucket: this.bucket,
					Key: `${prefix(id)}${entry.path}`,
					Body: body,
					ContentType: next.contentType,
				}),
			);
			manifest.push(next);
			artifacts.push(publicArtifact(next));
		}
		for (const removed of previous.values())
			await this.s3.send(
				new DeleteObjectCommand({
					Bucket: this.bucket,
					Key: `${prefix(id)}${removed.path}`,
				}),
			);
		if (artifacts.length || previous.size)
			await this.s3.send(
				new PutObjectCommand({
					Bucket: this.bucket,
					Key: `${prefix(id)}.manifest.json`,
					Body: JSON.stringify(manifest),
					ContentType: "application/json",
				}),
			);
		return {
			artifacts,
			removed: [...previous.values()].map((entry) => entry.artifactId),
		};
	}
}

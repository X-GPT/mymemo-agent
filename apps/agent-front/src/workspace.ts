import {
	type BedrockAgentCoreClient,
	type CodeInterpreterResult,
	InvokeCodeInterpreterCommand,
	StartCodeInterpreterSessionCommand,
	StopCodeInterpreterSessionCommand,
	type ToolArguments,
	type ToolName,
} from "@aws-sdk/client-bedrock-agentcore";
import {
	GetObjectCommand,
	PutObjectCommand,
	type S3Client,
} from "@aws-sdk/client-s3";

const MAX_BYTES = 64 * 1024 * 1024;
const PART_BYTES = 8 * 1024 * 1024;
const key = (id: string) => `_workspace/${id}/workspace.tgz`;

export class WorkspaceTooLarge extends Error {
	constructor() {
		super("workspace_too_large");
	}
}

export class Workspace {
	constructor(
		readonly client: BedrockAgentCoreClient,
		readonly interpreterId: string,
		readonly s3: S3Client,
		readonly bucket: string,
	) {}

	async call(sessionId: string, name: ToolName, args: ToolArguments) {
		const response = await this.client.send(
			new InvokeCodeInterpreterCommand({
				codeInterpreterIdentifier: this.interpreterId,
				sessionId,
				name,
				arguments: args,
			}),
		);
		let result: CodeInterpreterResult | undefined;
		for await (const event of response.stream ?? []) {
			if (event.result) result = event.result;
			else throw new Error("Code Interpreter stream failed");
		}
		if (
			!result ||
			result.isError ||
			(result.structuredContent?.exitCode ?? 0) !== 0
		)
			throw new Error("Code Interpreter operation failed");
		return result;
	}

	async start(turnId: string, conversationId: string | null = null) {
		const started = performance.now();
		const response = await this.client.send(
			new StartCodeInterpreterSessionCommand({
				codeInterpreterIdentifier: this.interpreterId,
				clientToken: turnId.padEnd(33, "0"),
				sessionTimeoutSeconds: 900,
			}),
		);
		if (!response.sessionId) throw new Error("Sandbox session did not start");
		console.log(
			JSON.stringify({
				conversationId,
				turnId,
				sessionId: response.sessionId,
				event: "sandbox_started",
				startSeconds: (performance.now() - started) / 1000,
			}),
		);
		return response.sessionId;
	}

	async restore(id: string, sessionId: string, turnId: string | null = null) {
		const started = performance.now();
		let archive: Uint8Array | undefined;
		try {
			const object = await this.s3.send(
				new GetObjectCommand({ Bucket: this.bucket, Key: key(id) }),
			);
			if (!object.Body) throw new Error("Workspace object has no body");
			archive = await object.Body.transformToByteArray();
		} catch (error) {
			if (!(error instanceof Error && error.name === "NoSuchKey")) throw error;
		}
		if (archive) {
			if (archive.byteLength > MAX_BYTES) throw new WorkspaceTooLarge();
			await this.call(sessionId, "writeFiles", {
				content: [{ path: "in.tgz", blob: archive }],
			});
		}
		await this.call(sessionId, "executeCommand", {
			command: `cd ~ && mkdir -p ws && ${archive ? "tar xzf in.tgz -C ws && rm in.tgz && " : ""}mkdir -p ws/artifacts ws/.mymemo/docs`,
		});
		console.log(
			JSON.stringify({
				conversationId: id,
				turnId,
				event: "workspace_restore",
				tarballBytes: archive?.byteLength ?? 0,
				copySeconds: (performance.now() - started) / 1000,
			}),
		);
	}

	async save(id: string, sessionId: string, turnId: string | null = null) {
		const started = performance.now();
		// PAX preserves fractional mtimes for artifact diffs after restoration.
		// Outside ws: the archive must never include itself or a previous export.
		const directory = `.workspace-export-${crypto.randomUUID()}`;
		const result = await this.call(sessionId, "executeCommand", {
			command: `cd ~ && mkdir ${directory} && tar --format=pax -czf ${directory}/out.tgz -C ws . && split -b 8m -d ${directory}/out.tgz ${directory}/part- && stat -c %s ${directory}/out.tgz`,
		});
		const size = Number(result.structuredContent?.stdout?.trim());
		if (!Number.isSafeInteger(size) || size <= 0)
			throw new Error("Invalid Workspace size");
		console.log(
			JSON.stringify({
				conversationId: id,
				turnId,
				event: "workspace_size",
				tarballBytes: size,
			}),
		);
		if (size > MAX_BYTES) throw new WorkspaceTooLarge();
		const paths = Array.from(
			{ length: Math.ceil(size / PART_BYTES) },
			(_, i) => `${directory}/part-${String(i).padStart(2, "0")}`,
		);
		await this.s3.send(
			new PutObjectCommand({
				Bucket: this.bucket,
				Key: key(id),
				Body: await this.readParts(sessionId, paths, size),
				ContentType: "application/gzip",
			}),
		);
		console.log(
			JSON.stringify({
				conversationId: id,
				turnId,
				event: "workspace_save",
				copySeconds: (performance.now() - started) / 1000,
			}),
		);
	}

	async readParts(sessionId: string, paths: string[], size: number) {
		const parts: Uint8Array[] = [];
		for (let i = 0; i < paths.length; i += 3) {
			// Three 8 MiB parts encode to 32 MiB, below the 35 MB response cap.
			const batch = paths.slice(i, i + 3);
			const response = await this.call(sessionId, "readFiles", {
				paths: batch,
			});
			if (response.content?.length !== batch.length)
				throw new Error("Missing file parts");
			for (const [index, content] of response.content.entries()) {
				const resource = content.resource;
				const blob =
					resource?.blob ??
					(typeof resource?.text === "string"
						? Buffer.from(resource.text)
						: undefined);
				if (
					!(blob instanceof Uint8Array) ||
					blob.byteLength !==
						Math.min(PART_BYTES, size - (i + index) * PART_BYTES)
				)
					throw new Error("Invalid file part");
				parts.push(blob);
			}
		}
		return Buffer.concat(parts);
	}

	async stop(sessionId: string) {
		await this.client.send(
			new StopCodeInterpreterSessionCommand({
				codeInterpreterIdentifier: this.interpreterId,
				sessionId,
			}),
		);
	}
}

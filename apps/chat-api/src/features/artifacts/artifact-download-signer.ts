export interface ArtifactDownloadSignInput {
	objectKey: string;
	expiresInSeconds: number;
	responseContentDisposition: string;
	responseContentType: string;
}

/** Signs a direct read of one already-authorized private object. */
export interface ArtifactDownloadSigner {
	createDownloadUrl(input: ArtifactDownloadSignInput): Promise<string>;
}

function sanitizeBasename(path: string): string {
	const basename = path.split("/").at(-1) || "artifact";
	const sanitized = Array.from(basename, (character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint < 0x20 ||
			codePoint === 0x7f ||
			character === '"' ||
			character === "\\"
			? "_"
			: character;
	}).join("");
	return sanitized || "artifact";
}

function encodeRfc5987(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/g,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

/** Force attachment handling while preserving a sanitized UTF-8 basename. */
export function attachmentContentDisposition(path: string): string {
	const basename = sanitizeBasename(path);
	const asciiFallback = Array.from(basename, (character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint >= 0x20 && codePoint <= 0x7e ? character : "_";
	}).join("");
	return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeRfc5987(basename)}`;
}

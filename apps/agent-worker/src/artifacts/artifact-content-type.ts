import { posix } from "node:path";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
	".csv": "text/csv",
	".docx":
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".gif": "image/gif",
	".html": "text/html",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".json": "application/json",
	".md": "text/markdown",
	".pdf": "application/pdf",
	".png": "image/png",
	".pptx":
		"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".svg": "image/svg+xml",
	".tar": "application/x-tar",
	".txt": "text/plain",
	".webp": "image/webp",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".xml": "application/xml",
	".zip": "application/zip",
};

/** Content type is selected only from the trusted artifact path extension. */
export function artifactContentType(path: string): string {
	return (
		CONTENT_TYPES[posix.extname(path).toLowerCase()] ??
		"application/octet-stream"
	);
}

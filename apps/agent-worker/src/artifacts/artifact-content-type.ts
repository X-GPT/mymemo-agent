/** Content type is selected only from the trusted artifact path extension. */
export function artifactContentType(path: string): string {
	return Bun.file(path).type.split(";", 1)[0] ?? "application/octet-stream";
}

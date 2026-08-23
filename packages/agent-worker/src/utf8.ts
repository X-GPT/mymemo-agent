/** Take a whole-character prefix within `maxBytes` UTF-8 bytes. */
export function takeUtf8Bytes(
	text: string,
	maxBytes: number,
): { text: string; truncated: boolean } {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) {
		return { text, truncated: false };
	}

	let bytes = 0;
	let output = "";
	for (const char of text) {
		const nextBytes = Buffer.byteLength(char, "utf8");
		if (bytes + nextBytes > maxBytes) {
			return { text: output, truncated: true };
		}
		bytes += nextBytes;
		output += char;
	}
	return { text: output, truncated: false };
}

import { type AcquisitionReceipt, parseAcquisitionReceipt } from "./contract";

const MAX_ACQUISITION_RECEIPT_BYTES = 8 * 1024;

/** Read one bounded newline-delimited receipt without waiting for Runtime EOF. */
export async function readAcquisitionReceipt(
	chunks: AsyncIterable<Uint8Array>,
	maxBytes = MAX_ACQUISITION_RECEIPT_BYTES,
): Promise<AcquisitionReceipt> {
	const decoder = new TextDecoder();
	let bytes = 0;
	let buffered = "";
	for await (const chunk of chunks) {
		bytes += chunk.byteLength;
		if (bytes > maxBytes) {
			throw new Error("AgentCore Acquisition receipt exceeded its byte limit");
		}
		buffered += decoder.decode(chunk, { stream: true });
		const newline = buffered.indexOf("\n");
		if (newline >= 0) {
			return parseAcquisitionReceipt(buffered.slice(0, newline));
		}
	}
	throw new Error("AgentCore Runtime ended without an Acquisition receipt");
}

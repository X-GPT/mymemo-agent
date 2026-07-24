export interface AgUiSseFrame {
	data: Record<string, unknown>;
}

/** Parse cursor-free standard AG-UI SSE with one BaseEvent JSON object per frame. */
export function parseAgUiSse(raw: string): AgUiSseFrame[] {
	const frames: AgUiSseFrame[] = [];
	for (const block of raw.split("\n\n")) {
		let data = "";
		for (const line of block.split("\n")) {
			if (line.startsWith("id:")) {
				throw new Error("AG-UI SSE frame carried an unexpected id");
			}
			if (line.startsWith("data:")) data = line.slice("data:".length).trim();
		}
		if (data) frames.push({ data: JSON.parse(data) });
	}
	return frames;
}

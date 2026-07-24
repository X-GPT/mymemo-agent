export interface AgUiSseFrame {
	data: Record<string, unknown>;
}

export interface RawAgUiSseFrame {
	event: string;
	data: string;
}

function parseAgUiSseBlocks(raw: string): RawAgUiSseFrame[] {
	const frames: RawAgUiSseFrame[] = [];
	for (const block of raw.replaceAll("\r\n", "\n").split("\n\n")) {
		let event = "";
		const data: string[] = [];
		for (const line of block.split("\n")) {
			if (line.startsWith("id:")) {
				throw new Error("AG-UI SSE frame carried an unexpected id");
			}
			if (line.startsWith("event:")) {
				event = line.slice("event:".length).trim();
			} else if (line.startsWith("data:")) {
				data.push(line.slice("data:".length).trimStart());
			}
		}
		const frameData = data.join("\n");
		if (!event && frameData) {
			try {
				const parsed = JSON.parse(frameData) as { type?: unknown };
				if (typeof parsed.type === "string") event = parsed.type;
			} catch {
				// The caller reports malformed JSON with the recovered event context.
			}
		}
		if (event || frameData) frames.push({ event, data: frameData });
	}
	return frames;
}

/**
 * Parse cursor-free standard AG-UI SSE while retaining its optional event name.
 * Event names omitted by data-only streams are recovered from the AG-UI type.
 */
export function parseRawAgUiSse(raw: string): RawAgUiSseFrame[] {
	return parseAgUiSseBlocks(raw).filter((frame) => frame.event);
}

/** Parse cursor-free standard AG-UI SSE with one BaseEvent JSON object per frame. */
export function parseAgUiSse(raw: string): AgUiSseFrame[] {
	return parseAgUiSseBlocks(raw)
		.filter((frame) => frame.data)
		.map((frame) => ({
			data: JSON.parse(frame.data) as Record<string, unknown>,
		}));
}

export interface AgUiSseFrame {
	data: Record<string, unknown>;
}

export interface RawAgUiSseFrame {
	event: string;
	data: string;
}

interface AgUiSseField {
	name: "event" | "data";
	value: string;
}

type AgUiSseBlock = AgUiSseField[];

function scanAgUiSse(raw: string): AgUiSseBlock[] {
	return raw.split("\n\n").map((block) => {
		const fields: AgUiSseField[] = [];
		for (const line of block.split("\n")) {
			if (line.startsWith("id:")) {
				throw new Error("AG-UI SSE frame carried an unexpected id");
			}
			if (line.startsWith("event:")) {
				fields.push({
					name: "event",
					value: line.slice("event:".length),
				});
			} else if (line.startsWith("data:")) {
				fields.push({
					name: "data",
					value: line.slice("data:".length),
				});
			}
		}
		return fields;
	});
}

/**
 * Parse cursor-free standard AG-UI SSE while retaining its optional event name.
 * Event names omitted by data-only streams are recovered from the AG-UI type.
 */
export function parseRawAgUiSse(raw: string): RawAgUiSseFrame[] {
	const frames: RawAgUiSseFrame[] = [];
	for (const fields of scanAgUiSse(raw.replaceAll("\r\n", "\n"))) {
		let event = "";
		const data: string[] = [];
		for (const field of fields) {
			if (field.name === "event") {
				event = field.value.trim();
			} else {
				data.push(field.value.trimStart());
			}
		}
		const frameData = data.join("\n");
		if (!event && frameData) {
			try {
				const parsed = JSON.parse(frameData) as { type?: unknown };
				if (typeof parsed.type === "string") event = parsed.type;
			} catch {
				// Without an explicit event name, malformed data cannot be classified.
			}
		}
		if (event) frames.push({ event, data: frameData });
	}
	return frames;
}

/** Parse cursor-free standard AG-UI SSE with one BaseEvent JSON object per frame. */
export function parseAgUiSse(raw: string): AgUiSseFrame[] {
	const frames: AgUiSseFrame[] = [];
	for (const fields of scanAgUiSse(raw)) {
		let data = "";
		for (const field of fields) {
			if (field.name === "data") data = field.value.trim();
		}
		if (data) frames.push({ data: JSON.parse(data) });
	}
	return frames;
}

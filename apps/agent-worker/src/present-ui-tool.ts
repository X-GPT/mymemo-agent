import { validateUiPayload } from "./ui-payload-validator";

export const PRESENT_UI_TOOL_NAME = "PresentUI";

/** Static steering for the display-only catalog (ADR-0017). */
export const PRESENT_UI_TOOL_DESCRIPTION = [
	"Present one validated display-only UI component when visual form materially beats prose.",
	"Use chart or table for quantitative comparisons and distributions, citation-card for source attribution, and diagram for process or structure explanations.",
	"Never use UI merely to decorate an answer prose already serves.",
	"Never solicit interaction: every component is display-only.",
	"The surrounding message text must carry the complete answer even if the UI never renders.",
].join(" ");

const REPAIR_DETAIL_MAX_UTF8_BYTES = 512;

interface PresentUiToolResult {
	content: { type: "text"; text: string }[];
	isError?: true;
}

/** Pure executor handler: shared validation in, bounded ack or repair error out. */
export function runPresentUiTool(input: unknown): PresentUiToolResult {
	const result = validateUiPayload(input);
	if (!result.ok) {
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						error: "invalid_ui_payload",
						rule: result.violation.rule,
						detail: clampUtf8(
							result.violation.detail,
							REPAIR_DETAIL_MAX_UTF8_BYTES,
						),
					}),
				},
			],
			isError: true,
		};
	}

	return {
		content: [
			{
				type: "text",
				text: JSON.stringify({
					accepted: true,
					component: result.value.component,
				}),
			},
		],
	};
}

function clampUtf8(value: string, maxBytes: number): string {
	const encoded = new TextEncoder().encode(value);
	if (encoded.byteLength <= maxBytes) return value;
	return new TextDecoder().decode(encoded.slice(0, maxBytes));
}

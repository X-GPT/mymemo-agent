import type { UiNode } from "@mymemo/agent-db/run-events";

export const UI_PAYLOAD_VERSION = 1 as const;

/** Same serialized width as the UUID minted for the owning Assistant message. */
export const UI_PAYLOAD_MESSAGE_ID_PLACEHOLDER =
	"00000000-0000-0000-0000-000000000000";

/** ADR-0017 wire-contract caps. Deploy configuration must not change these. */
export const UI_PAYLOAD_LIMITS = {
	envelopeBytes: 16 * 1_024,
	titleCharacters: 200,
	diagramSourceBytes: 4 * 1_024,
	tableRows: 50,
	tableColumns: 8,
	tableLabelCharacters: 200,
	tableCellCharacters: 200,
	citationSnippetCharacters: 500,
	citationSourceCharacters: 100,
	cardChildren: 16,
	cardChildCharacters: 1_000,
} as const;

export const UiPayloadRule = {
	EnvelopeInvalid: "envelope_invalid",
	VersionInvalid: "version_invalid",
	ComponentInvalid: "component_invalid",
	ComponentUnknown: "component_unknown",
	ExtraProperty: "extra_property",
	TitleTooLong: "title_too_long",
	DiagramSourceTooLarge: "diagram_source_too_large",
	TableRowsTooMany: "table_rows_too_many",
	TableColumnsTooMany: "table_columns_too_many",
	TableLabelTooLong: "table_label_too_long",
	TableAlignInvalid: "table_align_invalid",
	TableCellInvalid: "table_cell_invalid",
	TableCellTooLong: "table_cell_too_long",
	TableRowKeyUnknown: "table_row_key_unknown",
	CitationSnippetTooLong: "citation_snippet_too_long",
	CitationSourceTooLong: "citation_source_too_long",
	CitationRelevanceOutOfRange: "citation_relevance_out_of_range",
	CardToneInvalid: "card_tone_invalid",
	CardChildrenTooMany: "card_children_too_many",
	CardChildTooLong: "card_child_too_long",
	CardChildInvalid: "card_child_invalid",
	CardNested: "card_nested",
	EnvelopeTooLarge: "envelope_too_large",
} as const;

export type UiPayloadRule = (typeof UiPayloadRule)[keyof typeof UiPayloadRule];

export type UiPayloadViolation = {
	rule: UiPayloadRule;
	detail: string;
};

export type UiPayloadValidationResult =
	| { ok: true; value: UiNode }
	| { ok: false; violation: UiPayloadViolation };

const COMPONENT_PROP_KEYS = {
	diagram: ["title", "source"],
	table: ["title", "columns", "rows"],
	"citation-card": ["title", "snippet", "source", "relevance"],
	card: ["title", "tone"],
} as const;

/** Validate one model-authored v1 catalog envelope without performing I/O. */
export function validateUiPayload(input: unknown): UiPayloadValidationResult {
	if (!isRecord(input)) {
		return violation(
			UiPayloadRule.EnvelopeInvalid,
			"payload envelope must be an object",
		);
	}
	const envelopeExtra = firstExtraKey(input, ["version", "payload"]);
	if (envelopeExtra !== undefined) return extraProperty(envelopeExtra);
	if (input.version !== UI_PAYLOAD_VERSION) {
		return violation(
			UiPayloadRule.VersionInvalid,
			`version must be ${UI_PAYLOAD_VERSION}`,
		);
	}
	if (!isRecord(input.payload)) {
		return violation(
			UiPayloadRule.ComponentInvalid,
			"payload must contain one component object",
		);
	}
	const component = input.payload.component;
	if (typeof component !== "string") {
		return violation(
			UiPayloadRule.ComponentInvalid,
			"component must be a string",
		);
	}
	if (!Object.hasOwn(COMPONENT_PROP_KEYS, component)) {
		return violation(
			UiPayloadRule.ComponentUnknown,
			`component "${component}" is not supported`,
		);
	}

	const nodeExtra = firstExtraKey(
		input.payload,
		component === "card"
			? ["component", "props", "children"]
			: ["component", "props"],
	);
	if (nodeExtra !== undefined) return extraProperty(nodeExtra);
	if (!isRecord(input.payload.props)) {
		return violation(
			UiPayloadRule.ComponentInvalid,
			`${component} props must be an object`,
		);
	}
	const propsExtra = firstExtraKey(
		input.payload.props,
		COMPONENT_PROP_KEYS[component as keyof typeof COMPONENT_PROP_KEYS],
	);
	if (propsExtra !== undefined) return extraProperty(propsExtra);
	if (component === "diagram") {
		const invalid = validateDiagramProps(input.payload.props);
		if (invalid) return invalid;
	}
	if (component === "table") {
		const invalid = validateTableProps(input.payload.props);
		if (invalid) return invalid;
	}
	if (component === "citation-card") {
		const invalid = validateCitationCardProps(input.payload.props);
		if (invalid) return invalid;
	}
	if (component === "card") {
		const invalid = validateCard(input.payload);
		if (invalid) return invalid;
	}
	const envelopeBytes = serializedEnvelopeBytes(input.payload);
	if (envelopeBytes > UI_PAYLOAD_LIMITS.envelopeBytes) {
		return violation(
			UiPayloadRule.EnvelopeTooLarge,
			`serialized UI payload is ${envelopeBytes} bytes, over the ${UI_PAYLOAD_LIMITS.envelopeBytes}-byte envelope; shrink the payload`,
		);
	}

	return { ok: true, value: input.payload as unknown as UiNode };
}

function serializedEnvelopeBytes(payload: Record<string, unknown>): number {
	return utf8ByteLength(
		JSON.stringify({
			messageId: UI_PAYLOAD_MESSAGE_ID_PLACEHOLDER,
			version: UI_PAYLOAD_VERSION,
			payload,
		}),
	);
}

function validateCard(
	node: Record<string, unknown>,
): UiPayloadValidationResult | undefined {
	const props = node.props as Record<string, unknown>;
	const invalidTitle = validateOptionalTitle(props.title, "card");
	if (invalidTitle) return invalidTitle;
	if (
		props.tone !== undefined &&
		props.tone !== "neutral" &&
		props.tone !== "info" &&
		props.tone !== "success" &&
		props.tone !== "warning" &&
		props.tone !== "danger"
	) {
		return violation(
			UiPayloadRule.CardToneInvalid,
			"card tone must be neutral, info, success, warning, or danger",
		);
	}
	if (node.children === undefined) return;
	if (!Array.isArray(node.children)) {
		return violation(
			UiPayloadRule.CardChildInvalid,
			"card children must be an array",
		);
	}
	if (node.children.length > UI_PAYLOAD_LIMITS.cardChildren) {
		return violation(
			UiPayloadRule.CardChildrenTooMany,
			`card must have at most ${UI_PAYLOAD_LIMITS.cardChildren} children; remove children`,
		);
	}
	for (const [index, child] of node.children.entries()) {
		if (typeof child === "string") {
			if (child.length > UI_PAYLOAD_LIMITS.cardChildCharacters) {
				return violation(
					UiPayloadRule.CardChildTooLong,
					`card child ${index} must be at most ${UI_PAYLOAD_LIMITS.cardChildCharacters} characters; shrink the child`,
				);
			}
			continue;
		}
		if (!isRecord(child)) {
			return violation(
				UiPayloadRule.CardChildInvalid,
				`card child ${index} must be text or a component node`,
			);
		}
		if (child.component === "card") {
			return violation(
				UiPayloadRule.CardNested,
				`card child ${index} cannot be another card; flatten the card`,
			);
		}
		const childResult = validateUiPayload({
			version: UI_PAYLOAD_VERSION,
			payload: child,
		});
		if (!childResult.ok) return childResult;
	}
}

function validateCitationCardProps(
	props: Record<string, unknown>,
): UiPayloadValidationResult | undefined {
	if (typeof props.title !== "string") {
		return violation(
			UiPayloadRule.ComponentInvalid,
			"citation-card title must be a string",
		);
	}
	const invalidTitle = validateOptionalTitle(props.title, "citation-card");
	if (invalidTitle) return invalidTitle;
	if (typeof props.snippet !== "string") {
		return violation(
			UiPayloadRule.ComponentInvalid,
			"citation-card snippet must be a string",
		);
	}
	if (props.snippet.length > UI_PAYLOAD_LIMITS.citationSnippetCharacters) {
		return violation(
			UiPayloadRule.CitationSnippetTooLong,
			`citation-card snippet must be at most ${UI_PAYLOAD_LIMITS.citationSnippetCharacters} characters; shrink snippet`,
		);
	}
	if (!isRecord(props.source)) {
		return violation(
			UiPayloadRule.ComponentInvalid,
			"citation-card source must be an object",
		);
	}
	const sourceExtra = firstExtraKey(props.source, [
		"collection",
		"updated",
		"pages",
	]);
	if (sourceExtra !== undefined) return extraProperty(sourceExtra);
	for (const field of ["collection", "updated"] as const) {
		const value = props.source[field];
		if (value !== undefined && typeof value !== "string") {
			return violation(
				UiPayloadRule.ComponentInvalid,
				`citation-card source.${field} must be a string`,
			);
		}
		if (
			typeof value === "string" &&
			value.length > UI_PAYLOAD_LIMITS.citationSourceCharacters
		) {
			return citationSourceTooLong(field);
		}
	}
	const pages = props.source.pages;
	if (
		pages !== undefined &&
		typeof pages !== "string" &&
		!(typeof pages === "number" && Number.isFinite(pages))
	) {
		return violation(
			UiPayloadRule.ComponentInvalid,
			"citation-card source.pages must be a string or finite number",
		);
	}
	if (
		typeof pages === "string" &&
		pages.length > UI_PAYLOAD_LIMITS.citationSourceCharacters
	) {
		return citationSourceTooLong("pages");
	}
	if (
		props.relevance !== undefined &&
		(typeof props.relevance !== "number" ||
			!Number.isFinite(props.relevance) ||
			props.relevance < 0 ||
			props.relevance > 1)
	) {
		return violation(
			UiPayloadRule.CitationRelevanceOutOfRange,
			"citation-card relevance must be a number from 0 through 1",
		);
	}
}

function citationSourceTooLong(field: string): UiPayloadValidationResult {
	return violation(
		UiPayloadRule.CitationSourceTooLong,
		`citation-card source.${field} must be at most ${UI_PAYLOAD_LIMITS.citationSourceCharacters} characters; shrink ${field}`,
	);
}

function validateTableProps(
	props: Record<string, unknown>,
): UiPayloadValidationResult | undefined {
	const invalidTitle = validateOptionalTitle(props.title, "table");
	if (invalidTitle) return invalidTitle;
	if (!Array.isArray(props.columns) || !Array.isArray(props.rows)) {
		return violation(
			UiPayloadRule.ComponentInvalid,
			"table columns and rows must be arrays",
		);
	}
	if (props.columns.length > UI_PAYLOAD_LIMITS.tableColumns) {
		return violation(
			UiPayloadRule.TableColumnsTooMany,
			`table must have at most ${UI_PAYLOAD_LIMITS.tableColumns} columns; remove columns`,
		);
	}
	if (props.rows.length > UI_PAYLOAD_LIMITS.tableRows) {
		return violation(
			UiPayloadRule.TableRowsTooMany,
			`table must have at most ${UI_PAYLOAD_LIMITS.tableRows} rows; remove rows`,
		);
	}

	const columnKeys = new Set<string>();
	for (const [index, column] of props.columns.entries()) {
		if (!isRecord(column)) {
			return violation(
				UiPayloadRule.ComponentInvalid,
				`table column ${index} must be an object`,
			);
		}
		const extra = firstExtraKey(column, ["key", "label", "align"]);
		if (extra !== undefined) return extraProperty(extra);
		if (typeof column.key !== "string" || typeof column.label !== "string") {
			return violation(
				UiPayloadRule.ComponentInvalid,
				`table column ${index} key and label must be strings`,
			);
		}
		if (column.label.length > UI_PAYLOAD_LIMITS.tableLabelCharacters) {
			return violation(
				UiPayloadRule.TableLabelTooLong,
				`table column ${index} label must be at most ${UI_PAYLOAD_LIMITS.tableLabelCharacters} characters; shrink label`,
			);
		}
		if (
			column.align !== undefined &&
			column.align !== "left" &&
			column.align !== "center" &&
			column.align !== "right"
		) {
			return violation(
				UiPayloadRule.TableAlignInvalid,
				`table column ${index} align must be left, center, or right`,
			);
		}
		columnKeys.add(column.key);
	}

	for (const [rowIndex, row] of props.rows.entries()) {
		if (!isRecord(row)) {
			return violation(
				UiPayloadRule.ComponentInvalid,
				`table row ${rowIndex} must be an object`,
			);
		}
		for (const [key, cell] of Object.entries(row)) {
			if (!columnKeys.has(key)) {
				return violation(
					UiPayloadRule.TableRowKeyUnknown,
					`table row ${rowIndex} key "${key}" is not a declared column; remove it or declare the column`,
				);
			}
			if (!isTableCell(cell)) {
				return violation(
					UiPayloadRule.TableCellInvalid,
					`table row ${rowIndex} cell "${key}" must be a string, finite number, boolean, or null`,
				);
			}
			if (String(cell).length > UI_PAYLOAD_LIMITS.tableCellCharacters) {
				return violation(
					UiPayloadRule.TableCellTooLong,
					`table row ${rowIndex} cell "${key}" must be at most ${UI_PAYLOAD_LIMITS.tableCellCharacters} characters; shrink the cell`,
				);
			}
		}
	}
}

function validateDiagramProps(
	props: Record<string, unknown>,
): UiPayloadValidationResult | undefined {
	const invalidTitle = validateOptionalTitle(props.title, "diagram");
	if (invalidTitle) return invalidTitle;
	if (typeof props.source !== "string") {
		return violation(
			UiPayloadRule.ComponentInvalid,
			"diagram source must be a string",
		);
	}
	if (utf8ByteLength(props.source) > UI_PAYLOAD_LIMITS.diagramSourceBytes) {
		return violation(
			UiPayloadRule.DiagramSourceTooLarge,
			`diagram source must be at most ${UI_PAYLOAD_LIMITS.diagramSourceBytes} UTF-8 bytes; shrink source`,
		);
	}
}

function validateOptionalTitle(
	value: unknown,
	component: string,
): UiPayloadValidationResult | undefined {
	if (value === undefined) return;
	if (typeof value !== "string") {
		return violation(
			UiPayloadRule.ComponentInvalid,
			`${component} title must be a string`,
		);
	}
	if (value.length > UI_PAYLOAD_LIMITS.titleCharacters) {
		return violation(
			UiPayloadRule.TitleTooLong,
			`${component} title must be at most ${UI_PAYLOAD_LIMITS.titleCharacters} characters; shrink title`,
		);
	}
}

function extraProperty(property: string): UiPayloadValidationResult {
	return violation(
		UiPayloadRule.ExtraProperty,
		`${property} is not allowed; remove it`,
	);
}

function violation(
	rule: UiPayloadRule,
	detail: string,
): UiPayloadValidationResult {
	return { ok: false, violation: { rule, detail } };
}

function firstExtraKey(
	value: Record<string, unknown>,
	allowed: readonly string[],
): string | undefined {
	return Object.keys(value).find((key) => !allowed.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTableCell(
	value: unknown,
): value is string | number | boolean | null {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	);
}

function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

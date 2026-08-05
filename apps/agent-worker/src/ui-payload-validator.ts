import type { UiNode } from "@mymemo/agent-db/run-events";
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
// Vendored from https://unpkg.com/vega-lite@5.23.0/build/vega-lite-schema.json
// SHA-256: 1aeeda8aa44dcce60f6b6fb7d8b650487e3e389a8284a2040e590be9a4c7610e
import vegaLiteV5Schema from "./schemas/vega-lite-v5.23.0.schema.json";

export const UI_PAYLOAD_VERSION = 1 as const;

/** Same serialized width as the UUID minted for the owning Assistant message. */
export const UI_PAYLOAD_MESSAGE_ID_PLACEHOLDER =
	"00000000-0000-0000-0000-000000000000";

/** ADR-0017 wire-contract caps. Deploy configuration must not change these. */
export const UI_PAYLOAD_LIMITS = {
	envelopeBytes: 16 * 1_024,
	titleCharacters: 200,
	chartSpecBytes: 8 * 1_024,
	chartDataRows: 200,
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
	ChartSpecTooLarge: "chart_spec_too_large",
	ChartSchemaInvalid: "chart_schema_invalid",
	ChartDataNotInline: "chart_data_not_inline",
	ChartDataValuesInvalid: "chart_data_values_invalid",
	ChartDataRowsTooMany: "chart_data_rows_too_many",
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

type SupportedComponent =
	| "chart"
	| "diagram"
	| "table"
	| "citation-card"
	| "card";

type ComponentDefinition = {
	nodeKeys: readonly string[];
	propKeys: readonly string[];
	validate: (
		node: Record<string, unknown>,
		props: Record<string, unknown>,
	) => UiPayloadValidationResult | undefined;
};

const COMPONENT_DEFINITIONS: Record<SupportedComponent, ComponentDefinition> = {
	chart: {
		nodeKeys: ["component", "props"],
		propKeys: ["title", "spec"],
		validate: (_node, props) => validateChartProps(props),
	},
	diagram: {
		nodeKeys: ["component", "props"],
		propKeys: ["title", "source"],
		validate: (_node, props) => validateDiagramProps(props),
	},
	table: {
		nodeKeys: ["component", "props"],
		propKeys: ["title", "columns", "rows"],
		validate: (_node, props) => validateTableProps(props),
	},
	"citation-card": {
		nodeKeys: ["component", "props"],
		propKeys: ["title", "snippet", "source", "relevance"],
		validate: (_node, props) => validateCitationCardProps(props),
	},
	card: {
		nodeKeys: ["component", "props", "children"],
		propKeys: ["title", "tone"],
		validate: (node) => validateCard(node),
	},
};

const TABLE_ALIGNS = ["left", "center", "right"] as const;
const CARD_TONES = ["neutral", "info", "success", "warning", "danger"] as const;
export const CHART_SCHEMA_DETAIL_CHARACTERS = 300;

let cachedVegaLiteValidator: ValidateFunction | undefined;

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
	if (!isSupportedUiComponent(component)) {
		return violation(
			UiPayloadRule.ComponentUnknown,
			`component "${component}" is not supported`,
		);
	}
	const definition = COMPONENT_DEFINITIONS[component];

	const nodeExtra = firstExtraKey(input.payload, definition.nodeKeys);
	if (nodeExtra !== undefined) return extraProperty(nodeExtra);
	if (!isRecord(input.payload.props)) {
		return violation(
			UiPayloadRule.ComponentInvalid,
			`${component} props must be an object`,
		);
	}
	const propsExtra = firstExtraKey(input.payload.props, definition.propKeys);
	if (propsExtra !== undefined) return extraProperty(propsExtra);
	const invalid = definition.validate(input.payload, input.payload.props);
	if (invalid) return invalid;
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

function validateChartProps(
	props: Record<string, unknown>,
): UiPayloadValidationResult | undefined {
	const invalidTitle = validateTitle(props.title, "chart");
	if (invalidTitle) return invalidTitle;
	if (!isRecord(props.spec)) {
		return violation(
			UiPayloadRule.ComponentInvalid,
			"chart spec must be an object",
		);
	}

	const specBytes = utf8ByteLength(JSON.stringify(props.spec));
	if (specBytes > UI_PAYLOAD_LIMITS.chartSpecBytes) {
		return violation(
			UiPayloadRule.ChartSpecTooLarge,
			`serialized chart spec is ${specBytes} bytes, over the ${UI_PAYLOAD_LIMITS.chartSpecBytes}-byte limit; shrink the spec`,
		);
	}

	const validateSpec = getVegaLiteValidator();
	if (!validateSpec(props.spec)) {
		return violation(
			UiPayloadRule.ChartSchemaInvalid,
			boundedVegaLiteError(validateSpec.errors?.[0]),
		);
	}

	const dataInspection = inspectChartData(props.spec);
	if (dataInspection.nonInlinePath !== undefined) {
		return violation(
			UiPayloadRule.ChartDataNotInline,
			`${dataInspection.nonInlinePath} must use inline data.values; inline the data source`,
		);
	}
	if (dataInspection.invalidValuesPath !== undefined) {
		return violation(
			UiPayloadRule.ChartDataValuesInvalid,
			`${dataInspection.invalidValuesPath} must be an array so every inline row can be counted; convert values to an array`,
		);
	}
	if (dataInspection.rows > UI_PAYLOAD_LIMITS.chartDataRows) {
		return violation(
			UiPayloadRule.ChartDataRowsTooMany,
			`chart has ${dataInspection.rows} inline data rows, over the ${UI_PAYLOAD_LIMITS.chartDataRows}-row limit; remove rows`,
		);
	}
}

function getVegaLiteValidator(): ValidateFunction {
	if (cachedVegaLiteValidator === undefined) {
		cachedVegaLiteValidator = new Ajv({
			allErrors: false,
			strict: false,
			validateFormats: false,
		}).compile(vegaLiteV5Schema);
	}
	return cachedVegaLiteValidator;
}

function boundedVegaLiteError(error: ErrorObject | undefined): string {
	const path = error?.instancePath || "/";
	const message = error?.message ?? "does not match the pinned schema";
	return `Vega-Lite spec is invalid at ${path}: ${message}`.slice(
		0,
		CHART_SCHEMA_DETAIL_CHARACTERS,
	);
}

function inspectChartData(spec: Record<string, unknown>): {
	rows: number;
	nonInlinePath?: string;
	invalidValuesPath?: string;
} {
	let rows = 0;
	let nonInlinePath: string | undefined;
	let invalidValuesPath: string | undefined;

	const visitData = (data: unknown, path: string) => {
		if (nonInlinePath !== undefined || invalidValuesPath !== undefined) return;
		if (data === null) return;
		if (!isRecord(data) || !Object.hasOwn(data, "values")) {
			nonInlinePath = path;
			return;
		}
		if (!Array.isArray(data.values)) {
			invalidValuesPath = `${path}.values`;
			return;
		}
		rows += data.values.length;
	};

	const visitSpec = (candidate: unknown, path: string) => {
		if (
			!isRecord(candidate) ||
			nonInlinePath !== undefined ||
			invalidValuesPath !== undefined
		) {
			return;
		}
		if (Object.hasOwn(candidate, "datasets")) {
			nonInlinePath = `${path}.datasets`;
			return;
		}
		if (Object.hasOwn(candidate, "data")) {
			visitData(candidate.data, `${path}.data`);
		}
		if (Array.isArray(candidate.transform)) {
			for (const [index, transform] of candidate.transform.entries()) {
				if (
					isRecord(transform) &&
					isRecord(transform.from) &&
					Object.hasOwn(transform.from, "data")
				) {
					visitData(
						transform.from.data,
						`${path}.transform[${index}].from.data`,
					);
				}
			}
		}
		for (const property of ["layer", "concat", "hconcat", "vconcat"] as const) {
			const children = candidate[property];
			if (!Array.isArray(children)) continue;
			for (const [index, child] of children.entries()) {
				visitSpec(child, `${path}.${property}[${index}]`);
			}
		}
		if (Object.hasOwn(candidate, "spec")) {
			visitSpec(candidate.spec, `${path}.spec`);
		}
	};

	visitSpec(spec, "chart spec");
	if (nonInlinePath !== undefined) return { rows, nonInlinePath };
	if (invalidValuesPath !== undefined) return { rows, invalidValuesPath };
	return { rows };
}

function validateCard(
	node: Record<string, unknown>,
): UiPayloadValidationResult | undefined {
	const props = node.props as Record<string, unknown>;
	const invalidTitle = validateTitle(props.title, "card");
	if (invalidTitle) return invalidTitle;
	if (props.tone !== undefined && !isAllowedString(props.tone, CARD_TONES)) {
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
	const invalidTitle = validateTitle(props.title, "citation-card", true);
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
	const invalidTitle = validateTitle(props.title, "table");
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
			!isAllowedString(column.align, TABLE_ALIGNS)
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
	const invalidTitle = validateTitle(props.title, "diagram");
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

function validateTitle(
	value: unknown,
	component: string,
	required = false,
): UiPayloadValidationResult | undefined {
	if (value === undefined && !required) return;
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

/** Runtime catalog membership check for safe diagnostics and validation. */
export function isSupportedUiComponent(
	value: string,
): value is SupportedComponent {
	return Object.hasOwn(COMPONENT_DEFINITIONS, value);
}

function isAllowedString(
	value: unknown,
	allowed: readonly string[],
): value is string {
	return typeof value === "string" && allowed.includes(value);
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

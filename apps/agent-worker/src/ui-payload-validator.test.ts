import { describe, expect, it } from "bun:test";
import type { UiNode } from "@mymemo/agent-db/run-events";
import {
	UI_PAYLOAD_LIMITS,
	UI_PAYLOAD_MESSAGE_ID_PLACEHOLDER,
	UI_PAYLOAD_VERSION,
	UiPayloadRule,
	validateUiPayload,
} from "./ui-payload-validator";

function expectViolation(input: unknown, rule: UiPayloadRule, detail: string) {
	const result = validateUiPayload(input);
	expect(result).toMatchObject({
		ok: false,
		violation: { rule },
	});
	if (!result.ok) expect(result.violation.detail).toContain(detail);
}

function expectValid(payload: unknown) {
	expect(validateUiPayload({ version: UI_PAYLOAD_VERSION, payload })).toEqual({
		ok: true,
		value: payload as UiNode,
	});
}

function expectPayloadViolation(
	payload: unknown,
	rule: UiPayloadRule,
	detail: string,
) {
	expectViolation({ version: UI_PAYLOAD_VERSION, payload }, rule, detail);
}

function serializedEventBytes(payload: unknown, messageId: string): number {
	return new TextEncoder().encode(
		JSON.stringify({ messageId, version: UI_PAYLOAD_VERSION, payload }),
	).byteLength;
}

function tableAtSerializedEventBytes(targetBytes: number) {
	const columns = Array.from(
		{ length: UI_PAYLOAD_LIMITS.tableColumns },
		(_, index) => ({ key: `c${index}`, label: `Column ${index}` }),
	);
	const rows = Array.from({ length: UI_PAYLOAD_LIMITS.tableRows }, () =>
		Object.fromEntries(columns.map(({ key }) => [key, ""])),
	);
	const payload = { component: "table", props: { columns, rows } };
	let remaining =
		targetBytes -
		serializedEventBytes(payload, UI_PAYLOAD_MESSAGE_ID_PLACEHOLDER);
	for (const row of rows) {
		for (const { key } of columns) {
			const characters = Math.min(
				remaining,
				UI_PAYLOAD_LIMITS.tableCellCharacters,
			);
			row[key] = "x".repeat(characters);
			remaining -= characters;
			if (remaining === 0) return payload;
		}
	}
	throw new Error(`could not construct a ${targetBytes}-byte table fixture`);
}

describe("validateUiPayload", () => {
	it.each([
		{
			name: "diagram",
			payload: {
				component: "diagram",
				props: {
					title: "How a document becomes searchable",
					source:
						"flowchart TD\n  A[Upload document] --> B[Extract text & metadata]\n  B --> C[Chunk into passages]\n  C --> D[Index passages for search]\n  D --> E([Searchable document])\n  B -- new file version --> F[Reindex as new version]\n  F --> D",
				},
			},
		},
		{
			name: "table",
			payload: {
				component: "table",
				props: {
					title: "Largest documents in this collection",
					columns: [
						{ key: "title", label: "Document" },
						{ key: "topic", label: "Topic" },
						{ key: "pages", label: "Pages", align: "right" },
						{ key: "updated", label: "Updated" },
					],
					rows: [
						{
							title: "Engineering Handbook",
							topic: "Engineering",
							pages: 86,
							updated: "2026-06-30",
						},
					],
				},
			},
		},
		{
			name: "citation-card",
			payload: {
				component: "citation-card",
				props: {
					title: "New Hire Onboarding Guide 2026",
					snippet:
						"Every onboarding checklist item must be completed within the first two weeks; managers confirm completion in the HR portal before access reviews run.",
					source: {
						collection: "Employee Handbook & Ops",
						updated: "2026-05-14",
						pages: 24,
					},
					relevance: 0.92,
				},
			},
		},
		{
			name: "card",
			payload: {
				component: "card",
				props: { title: "Key points", tone: "info" },
				// The prototype predates ADR-0017's removal of the standalone text
				// component; its text-node bodies are the final string children.
				children: [
					"Indexing is per version — reindexing creates a new indexed version, never a second document.",
					"Only the highest active version serves search; older versions stay retrievable by id.",
				],
			},
		},
	])("validates the prototype's $name exemplar", ({ payload }) => {
		expectValid(payload);
	});

	it.each([
		{
			name: "a missing version",
			input: { payload: { component: "diagram", props: { source: "A-->B" } } },
			rule: UiPayloadRule.VersionInvalid,
			detail: "version",
		},
		{
			name: "an unknown version",
			input: {
				version: 2,
				payload: { component: "diagram", props: { source: "A-->B" } },
			},
			rule: UiPayloadRule.VersionInvalid,
			detail: "version",
		},
		{
			name: "an unknown component (including chart until #420)",
			input: { version: 1, payload: { component: "chart", props: {} } },
			rule: UiPayloadRule.ComponentUnknown,
			detail: "chart",
		},
		{
			name: "a component inherited from Object.prototype",
			input: { version: 1, payload: { component: "toString", props: {} } },
			rule: UiPayloadRule.ComponentUnknown,
			detail: "toString",
		},
		{
			name: "an extra envelope property",
			input: {
				version: 1,
				payload: { component: "diagram", props: { source: "A-->B" } },
				messageId: "not accepted from the model",
			},
			rule: UiPayloadRule.ExtraProperty,
			detail: "messageId",
		},
		{
			name: "an extra node property",
			input: {
				version: 1,
				payload: {
					component: "diagram",
					props: { source: "A-->B" },
					interactive: true,
				},
			},
			rule: UiPayloadRule.ExtraProperty,
			detail: "interactive",
		},
		{
			name: "an extra component property",
			input: {
				version: 1,
				payload: {
					component: "diagram",
					props: { source: "A-->B", url: "https://example.com" },
				},
			},
			rule: UiPayloadRule.ExtraProperty,
			detail: "url",
		},
		{
			name: "an empty-named extra property",
			input: {
				version: 1,
				payload: {
					component: "diagram",
					props: { source: "A-->B", "": true },
				},
			},
			rule: UiPayloadRule.ExtraProperty,
			detail: "not allowed",
		},
	])("rejects $name with a stable rule", ({ input, rule, detail }) => {
		expectViolation(input, rule, detail);
	});

	it("enforces diagram and title boundaries without linting Mermaid or markdown", () => {
		const atBoundary = {
			component: "diagram",
			props: {
				title: "t".repeat(UI_PAYLOAD_LIMITS.titleCharacters),
				source: "x".repeat(UI_PAYLOAD_LIMITS.diagramSourceBytes),
			},
		};
		expectValid(atBoundary);
		expectValid({
			component: "diagram",
			props: { source: "**not parsed** [or linted](javascript:ignored)" },
		});

		expectViolation(
			{
				version: UI_PAYLOAD_VERSION,
				payload: {
					...atBoundary,
					props: {
						...atBoundary.props,
						title: `${atBoundary.props.title}x`,
					},
				},
			},
			UiPayloadRule.TitleTooLong,
			"title",
		);
		expectViolation(
			{
				version: UI_PAYLOAD_VERSION,
				payload: {
					...atBoundary,
					props: {
						...atBoundary.props,
						source: `${atBoundary.props.source}x`,
					},
				},
			},
			UiPayloadRule.DiagramSourceTooLarge,
			"source",
		);
	});

	it("enforces every table boundary and the declared-column contract", () => {
		const column = { key: "value", label: "l" };
		const table = (columns: unknown[], rows: unknown[]) => ({
			component: "table",
			props: { columns, rows },
		});

		expectValid(
			table(
				Array.from({ length: UI_PAYLOAD_LIMITS.tableColumns }, (_, index) => ({
					key: `column-${index}`,
					label: "l".repeat(UI_PAYLOAD_LIMITS.tableLabelCharacters),
					align: (["left", "center", "right"] as const)[index % 3],
				})),
				[],
			),
		);
		expectPayloadViolation(
			table(
				Array.from(
					{ length: UI_PAYLOAD_LIMITS.tableColumns + 1 },
					(_, index) => ({ key: `column-${index}`, label: "Column" }),
				),
				[],
			),
			UiPayloadRule.TableColumnsTooMany,
			"columns",
		);

		expectValid(
			table(
				[column],
				Array.from({ length: UI_PAYLOAD_LIMITS.tableRows }, () => ({
					value: null,
				})),
			),
		);
		expectPayloadViolation(
			table(
				[column],
				Array.from({ length: UI_PAYLOAD_LIMITS.tableRows + 1 }, () => ({
					value: null,
				})),
			),
			UiPayloadRule.TableRowsTooMany,
			"rows",
		);

		expectValid(
			table(
				[
					{ key: "text", label: "Text" },
					{ key: "number", label: "Number" },
					{ key: "boolean", label: "Boolean" },
					{ key: "empty", label: "Empty" },
				],
				[
					{
						text: "x".repeat(UI_PAYLOAD_LIMITS.tableCellCharacters),
						number: 42,
						boolean: true,
						empty: null,
					},
				],
			),
		);
		expectPayloadViolation(
			table(
				[column],
				[
					{
						value: "x".repeat(UI_PAYLOAD_LIMITS.tableCellCharacters + 1),
					},
				],
			),
			UiPayloadRule.TableCellTooLong,
			"value",
		);
		expectPayloadViolation(
			table([column], [{ value: { script: "not a cell" } }]),
			UiPayloadRule.TableCellInvalid,
			"value",
		);
		expectPayloadViolation(
			table([column], [{ undeclared: "value" }]),
			UiPayloadRule.TableRowKeyUnknown,
			"undeclared",
		);
		expectPayloadViolation(
			table([{ ...column, align: "decimal" }], []),
			UiPayloadRule.TableAlignInvalid,
			"align",
		);
		expectPayloadViolation(
			table(
				[
					{
						...column,
						label: "l".repeat(UI_PAYLOAD_LIMITS.tableLabelCharacters + 1),
					},
				],
				[],
			),
			UiPayloadRule.TableLabelTooLong,
			"label",
		);
	});

	it("enforces citation-card text, source, and relevance boundaries", () => {
		const citation = {
			component: "citation-card",
			props: {
				title: "t".repeat(UI_PAYLOAD_LIMITS.titleCharacters),
				snippet: "s".repeat(UI_PAYLOAD_LIMITS.citationSnippetCharacters),
				source: {
					collection: "c".repeat(UI_PAYLOAD_LIMITS.citationSourceCharacters),
					updated: "u".repeat(UI_PAYLOAD_LIMITS.citationSourceCharacters),
					pages: "p".repeat(UI_PAYLOAD_LIMITS.citationSourceCharacters),
				},
				relevance: 1,
			},
		};
		expectValid(citation);
		expectValid({
			...citation,
			props: {
				...citation.props,
				snippet: "**strong** and *em*, with [syntax](left literal)",
				source: { pages: 24 },
				relevance: 0,
			},
		});

		expectPayloadViolation(
			{
				...citation,
				props: {
					...citation.props,
					title: `${citation.props.title}x`,
				},
			},
			UiPayloadRule.TitleTooLong,
			"title",
		);
		expectPayloadViolation(
			{
				...citation,
				props: {
					...citation.props,
					snippet: `${citation.props.snippet}x`,
				},
			},
			UiPayloadRule.CitationSnippetTooLong,
			"snippet",
		);
		for (const field of ["collection", "updated", "pages"] as const) {
			expectPayloadViolation(
				{
					...citation,
					props: {
						...citation.props,
						source: {
							...citation.props.source,
							[field]: `${citation.props.source[field]}x`,
						},
					},
				},
				UiPayloadRule.CitationSourceTooLong,
				field,
			);
		}
		for (const relevance of [-0.01, 1.01]) {
			expectPayloadViolation(
				{
					...citation,
					props: { ...citation.props, relevance },
				},
				UiPayloadRule.CitationRelevanceOutOfRange,
				"relevance",
			);
		}
		expectPayloadViolation(
			{
				...citation,
				props: {
					...citation.props,
					source: { ...citation.props.source, url: "https://example.com" },
				},
			},
			UiPayloadRule.ExtraProperty,
			"url",
		);
	});

	it("enforces card tone, child count, child length, and structural depth", () => {
		for (const tone of [
			undefined,
			"neutral",
			"info",
			"success",
			"warning",
			"danger",
		]) {
			expectValid({
				component: "card",
				props: tone === undefined ? {} : { tone },
			});
		}
		expectValid({
			component: "card",
			props: {},
			children: Array.from(
				{ length: UI_PAYLOAD_LIMITS.cardChildren },
				() => "point",
			),
		});
		expectValid({
			component: "card",
			props: {},
			children: ["x".repeat(UI_PAYLOAD_LIMITS.cardChildCharacters)],
		});
		expectValid({
			component: "card",
			props: {},
			children: [
				{
					component: "diagram",
					props: { source: "flowchart TD\nA-->B" },
				},
			],
		});

		expectPayloadViolation(
			{ component: "card", props: { tone: "decorative" } },
			UiPayloadRule.CardToneInvalid,
			"tone",
		);
		expectPayloadViolation(
			{
				component: "card",
				props: {},
				children: Array.from(
					{ length: UI_PAYLOAD_LIMITS.cardChildren + 1 },
					() => "point",
				),
			},
			UiPayloadRule.CardChildrenTooMany,
			"children",
		);
		expectPayloadViolation(
			{
				component: "card",
				props: {},
				children: ["x".repeat(UI_PAYLOAD_LIMITS.cardChildCharacters + 1)],
			},
			UiPayloadRule.CardChildTooLong,
			"child",
		);
		expectPayloadViolation(
			{
				component: "card",
				props: {},
				children: [{ component: "card", props: {} }],
			},
			UiPayloadRule.CardNested,
			"card",
		);
		expectPayloadViolation(
			{ component: "card", props: {}, children: [42] },
			UiPayloadRule.CardChildInvalid,
			"child",
		);
	});

	it("enforces the exact deterministic serialized envelope boundary", () => {
		const atBoundary = tableAtSerializedEventBytes(
			UI_PAYLOAD_LIMITS.envelopeBytes,
		);
		const overBoundary = tableAtSerializedEventBytes(
			UI_PAYLOAD_LIMITS.envelopeBytes + 1,
		);
		expect(
			serializedEventBytes(atBoundary, UI_PAYLOAD_MESSAGE_ID_PLACEHOLDER),
		).toBe(UI_PAYLOAD_LIMITS.envelopeBytes);
		expect(
			serializedEventBytes(atBoundary, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
		).toBe(UI_PAYLOAD_LIMITS.envelopeBytes);
		expectValid(atBoundary);

		const original = structuredClone(overBoundary);
		expectPayloadViolation(
			overBoundary,
			UiPayloadRule.EnvelopeTooLarge,
			`${UI_PAYLOAD_LIMITS.envelopeBytes + 1}`,
		);
		expect(overBoundary).toEqual(original);
	});

	it.each([
		{
			component: "diagram",
			props: { source: "A-->B" },
		},
		{
			component: "table",
			props: { columns: [], rows: [] },
		},
		{
			component: "citation-card",
			props: { title: "Source", snippet: "Evidence", source: {} },
		},
		{
			component: "card",
			props: {},
		},
	])("applies the shared title cap to $component", (payload) => {
		expectValid({
			...payload,
			props: {
				...payload.props,
				title: "t".repeat(UI_PAYLOAD_LIMITS.titleCharacters),
			},
		});
		expectPayloadViolation(
			{
				...payload,
				props: {
					...payload.props,
					title: "t".repeat(UI_PAYLOAD_LIMITS.titleCharacters + 1),
				},
			},
			UiPayloadRule.TitleTooLong,
			"title",
		);
	});

	it.each([
		{
			name: "a non-object envelope",
			input: null,
			rule: UiPayloadRule.EnvelopeInvalid,
			detail: "envelope",
		},
		{
			name: "missing component props",
			input: { version: 1, payload: { component: "diagram" } },
			rule: UiPayloadRule.ComponentInvalid,
			detail: "props",
		},
		{
			name: "a diagram missing source",
			input: { version: 1, payload: { component: "diagram", props: {} } },
			rule: UiPayloadRule.ComponentInvalid,
			detail: "source",
		},
		{
			name: "a table with malformed columns",
			input: {
				version: 1,
				payload: { component: "table", props: { columns: {}, rows: [] } },
			},
			rule: UiPayloadRule.ComponentInvalid,
			detail: "columns",
		},
		{
			name: "an extra column property",
			input: {
				version: 1,
				payload: {
					component: "table",
					props: {
						columns: [{ key: "a", label: "A", width: 100 }],
						rows: [],
					},
				},
			},
			rule: UiPayloadRule.ExtraProperty,
			detail: "width",
		},
		{
			name: "a citation missing required fields",
			input: {
				version: 1,
				payload: {
					component: "citation-card",
					props: { title: "Source", source: {} },
				},
			},
			rule: UiPayloadRule.ComponentInvalid,
			detail: "snippet",
		},
		{
			name: "an extra citation source property",
			input: {
				version: 1,
				payload: {
					component: "citation-card",
					props: {
						title: "Source",
						snippet: "Evidence",
						source: { author: "Unknown" },
					},
				},
			},
			rule: UiPayloadRule.ExtraProperty,
			detail: "author",
		},
		{
			name: "a child node with its own children slot",
			input: {
				version: 1,
				payload: {
					component: "card",
					props: {},
					children: [
						{
							component: "diagram",
							props: { source: "A-->B" },
							children: [],
						},
					],
				},
			},
			rule: UiPayloadRule.ExtraProperty,
			detail: "children",
		},
	])("strictly rejects $name", ({ input, rule, detail }) => {
		expectViolation(input, rule, detail);
	});

	it("exports the stable model-repair rule vocabulary", () => {
		expect(UiPayloadRule).toEqual({
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
		});
	});
});

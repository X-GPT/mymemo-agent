import { describe, expect, it } from "bun:test";
import { DocumentScopeError } from "./errors";
import { parseFrozenScope } from "./scope";

describe("parseFrozenScope — frozen scope guard", () => {
	it("parses the three legal scope shapes", () => {
		expect(
			parseFrozenScope({
				scope: "general",
				collectionId: null,
				summaryId: null,
			}),
		).toEqual({ type: "general" });
		expect(
			parseFrozenScope({
				scope: "collection",
				collectionId: "coll-1",
				summaryId: null,
			}),
		).toEqual({ type: "collection", collectionId: "coll-1" });
		expect(
			parseFrozenScope({
				scope: "document",
				collectionId: null,
				summaryId: "123",
			}),
		).toEqual({ type: "document", summaryId: "123" });
	});

	it("rejects a collection scope missing its collectionId", () => {
		expect(() =>
			parseFrozenScope({
				scope: "collection",
				collectionId: null,
				summaryId: null,
			}),
		).toThrow(DocumentScopeError);
	});

	it("rejects a document scope missing its summaryId", () => {
		expect(() =>
			parseFrozenScope({
				scope: "document",
				collectionId: null,
				summaryId: null,
			}),
		).toThrow(DocumentScopeError);
	});

	it("rejects an unknown scope value rather than widening to general", () => {
		expect(() =>
			parseFrozenScope({
				scope: "everything",
				collectionId: null,
				summaryId: null,
			}),
		).toThrow(DocumentScopeError);
	});
});

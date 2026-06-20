import { describe, expect, it } from "bun:test";
import { buildSandboxAgentPrompt } from "./sandbox-agent.prompt";

describe("buildSandboxAgentPrompt", () => {
	const baseOptions = {
		summaryId: null,
		collectionId: null,
		conversationContext: null,
	};

	it("includes citation format instructions", () => {
		const prompt = buildSandboxAgentPrompt({
			...baseOptions,
			scope: "general",
		});

		expect(prompt).toContain("[[N]][cN]");
		expect(prompt).toContain("passageId");
		expect(prompt).toContain("[c1]: p_abc123");
	});

	it("instructs use of the search_documents tool", () => {
		const prompt = buildSandboxAgentPrompt({
			...baseOptions,
			scope: "general",
		});

		expect(prompt).toContain("search_documents");
		expect(prompt).toContain("mcp__mymemo__search_documents");
	});

	it("states remote search is required by default", () => {
		const prompt = buildSandboxAgentPrompt({
			...baseOptions,
			scope: "general",
		});

		expect(prompt).toContain("Remote search is required by default");
	});

	it("describes local documents as the current working set only", () => {
		const prompt = buildSandboxAgentPrompt({
			...baseOptions,
			scope: "general",
		});

		expect(prompt).toContain("current working set");
	});

	it("permits local-only work only when the user scopes to loaded files", () => {
		const prompt = buildSandboxAgentPrompt({
			...baseOptions,
			scope: "general",
		});

		expect(prompt).toContain(
			"Local-only work is acceptable only when the user explicitly scopes",
		);
	});

	it("explains hydrated documents expose a local path the agent can Read", () => {
		const prompt = buildSandboxAgentPrompt({
			...baseOptions,
			scope: "general",
		});

		expect(prompt).toContain("localPath");
		expect(prompt).toContain("Read");
	});

	it("no longer instructs separate search then fetch via mymemo-docs", () => {
		const prompt = buildSandboxAgentPrompt({
			...baseOptions,
			scope: "general",
		});

		expect(prompt).not.toContain("mymemo-docs fetch");
		expect(prompt).not.toContain("mymemo-docs search");
	});

	it("includes source restriction rules", () => {
		const prompt = buildSandboxAgentPrompt({
			...baseOptions,
			scope: "general",
		});

		expect(prompt).toContain("ONLY use information from documents");
		expect(prompt).toContain("NEVER use outside knowledge");
	});

	describe("general scope", () => {
		it("includes general scope context", () => {
			const prompt = buildSandboxAgentPrompt({
				...baseOptions,
				scope: "general",
			});

			expect(prompt).toContain("across all of the user's documents");
		});
	});

	describe("collection scope", () => {
		it("explains search is auto-restricted to the collection", () => {
			const prompt = buildSandboxAgentPrompt({
				...baseOptions,
				scope: "collection",
				collectionId: "col-123",
			});

			expect(prompt).toContain("single collection");
			expect(prompt).toContain("automatically restricted");
		});
	});

	describe("document scope", () => {
		it("explains search is auto-restricted to the document", () => {
			const prompt = buildSandboxAgentPrompt({
				...baseOptions,
				scope: "document",
				summaryId: "doc-456",
			});

			expect(prompt).toContain("single specific document");
			expect(prompt).toContain("automatically restricted");
		});
	});

	it("appends conversation context when provided", () => {
		const prompt = buildSandboxAgentPrompt({
			...baseOptions,
			scope: "general",
			conversationContext: "User previously asked about budgets.",
		});

		expect(prompt).toContain("Conversation Context");
		expect(prompt).toContain("User previously asked about budgets.");
	});

	it("does not include conversation context section when null", () => {
		const prompt = buildSandboxAgentPrompt({
			...baseOptions,
			scope: "general",
			conversationContext: null,
		});

		expect(prompt).not.toContain("Conversation Context");
	});
});

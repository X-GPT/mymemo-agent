import { type Context, Hono } from "hono";
import { validator as zValidator } from "hono-openapi";
import { z } from "zod";
import type { AppEnv } from "@/deps";
import { ConversationIdParam } from "@/features/conversations/conversations.schema";
import { identityFromContext } from "@/features/conversations/internal-identity";
import { attachmentContentDisposition } from "./artifact-download-signer";

const app = new Hono<AppEnv>();
const ArtifactIdParam = ConversationIdParam;

async function ownedConversation(c: Context<AppEnv>, conversationId: string) {
	const identity = identityFromContext(c);
	if (!identity.success) return { outcome: "invalid_identity" as const };
	const conversation = await c.var.deps.conversationStore.get({
		userId: identity.data.memberCode,
		conversationId,
	});
	if (!conversation) return { outcome: "not_found" as const };
	return { outcome: "found" as const, identity: identity.data };
}

function ownershipErrorResponse(
	c: Context<AppEnv>,
	outcome: "invalid_identity" | "not_found",
) {
	if (outcome === "invalid_identity") {
		return c.json(
			{ error: "Missing or invalid internal identity headers" },
			401,
		);
	}
	return c.json({ error: "Conversation not found" }, 404);
}

app.get(
	"/:conversationId/artifacts",
	zValidator(
		"param",
		z.object({ conversationId: ConversationIdParam }),
		(result, c) => {
			if (!result.success) {
				return c.json({ error: "Invalid artifact path parameters" }, 400);
			}
		},
	),
	async (c) => {
		const { conversationId } = c.req.valid("param");
		const ownership = await ownedConversation(c, conversationId);
		if (ownership.outcome !== "found") {
			return ownershipErrorResponse(c, ownership.outcome);
		}

		const artifacts = await c.var.deps.artifactMetadataStore.listCurrent({
			userId: ownership.identity.memberCode,
			conversationId,
		});
		return c.json({ artifacts });
	},
);

app.get(
	"/:conversationId/artifacts/:artifactId/download-url",
	zValidator(
		"param",
		z.object({
			conversationId: ConversationIdParam,
			artifactId: ArtifactIdParam,
		}),
		(result, c) => {
			if (!result.success) {
				return c.json({ error: "Invalid artifact path parameters" }, 400);
			}
		},
	),
	async (c) => {
		const { conversationId, artifactId } = c.req.valid("param");
		const ownership = await ownedConversation(c, conversationId);
		if (ownership.outcome !== "found") {
			return ownershipErrorResponse(c, ownership.outcome);
		}

		const artifact = await c.var.deps.artifactMetadataStore.getCurrent({
			userId: ownership.identity.memberCode,
			conversationId,
			artifactId,
		});
		if (!artifact) return c.json({ error: "Artifact not found" }, 404);

		const downloadUrl =
			await c.var.deps.artifactDownloadSigner.createDownloadUrl({
				objectKey: artifact.objectKey,
				expiresInSeconds: 5 * 60,
				responseContentDisposition: attachmentContentDisposition(artifact.path),
				responseContentType: artifact.contentType,
			});
		c.header("Cache-Control", "private, no-store");
		return c.json({ downloadUrl });
	},
);

export default app;

import { sValidator as zValidator } from "@hono/standard-validator";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "@/deps";
import { ConversationIdParam } from "@/features/conversations/conversations.schema";
import { requireInternalIdentity } from "@/features/conversations/internal-identity";
import { attachmentContentDisposition } from "./artifact-download-signer";

const app = new Hono<AppEnv>();
const ArtifactIdParam = ConversationIdParam;

async function ownedConversation(c: Context<AppEnv>, conversationId: string) {
	const conversation = await c.var.deps.conversationStore.get({
		userId: c.var.identity.memberCode,
		conversationId,
	});
	return conversation !== null;
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
	requireInternalIdentity,
	async (c) => {
		const { conversationId } = c.req.valid("param");
		if (!(await ownedConversation(c, conversationId))) {
			return c.json({ error: "Conversation not found" }, 404);
		}

		const artifacts = await c.var.deps.artifactMetadataStore.listCurrent({
			userId: c.var.identity.memberCode,
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
	requireInternalIdentity,
	async (c) => {
		const { conversationId, artifactId } = c.req.valid("param");
		if (!(await ownedConversation(c, conversationId))) {
			return c.json({ error: "Conversation not found" }, 404);
		}

		const artifact = await c.var.deps.artifactMetadataStore.getCurrent({
			userId: c.var.identity.memberCode,
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

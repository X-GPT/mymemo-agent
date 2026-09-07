import { z } from "zod";

// Copied from chat-api; v1 is independently removable at cutover.
export const InternalIdentity = z.object({
	memberCode: z.string().min(1).max(256),
	partnerCode: z.string().min(1).max(256),
	teamCode: z.string().max(256).optional(),
});
export type InternalIdentity = z.infer<typeof InternalIdentity>;
export type Scope =
	| { kind: "general" }
	| { kind: "collection"; collectionId: string }
	| { kind: "document"; summaryId: string };
export interface ConversationSummary {
	conversationId: string;
	title: string | null;
	scope: Scope["kind"];
	createdAt: string;
	lastActivityAt: string;
	archivedAt: string | null;
}
export const ConversationId = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9_-]+$/);
export const CreateBody = z
	.object({
		collectionId: z.string().max(256).nullish(),
		summaryId: z.string().max(256).nullish(),
	})
	.strict();
export const UpdateBody = z.union([
	z.object({ title: z.string().trim().min(1).max(256) }).strict(),
	z.object({ archived: z.boolean() }).strict(),
]);
const Limit = z
	.string()
	.regex(/^\d+$/)
	.transform(Number)
	.pipe(z.number().int().min(1).max(100));
export const ListQuery = z
	.object({
		archived: z
			.enum(["true", "false"])
			.default("false")
			.transform((value) => value === "true"),
		search: z.string().trim().min(1).max(256).optional(),
		limit: Limit.default(20),
		cursor: z.string().min(1).max(4096).optional(),
	})
	.strict();
export const HistoryQuery = z
	.object({
		limit: Limit.default(20),
		cursor: z
			.string()
			.regex(/^\d+$/)
			.transform(Number)
			.pipe(z.number().int().positive().safe())
			.optional(),
	})
	.strict();
const Cursor = z
	.object({
		userId: z.string(),
		archived: z.boolean(),
		search: z.string().nullable(),
		conversationId: ConversationId,
		lastActivityAt: z.iso.datetime(),
	})
	.strict();
export type ListOptions = z.infer<typeof ListQuery> & { userId: string };
export type ListPosition = Pick<
	ConversationSummary,
	"conversationId" | "lastActivityAt"
>;
export function encodeCursor(query: ListOptions, position: ListPosition) {
	return Buffer.from(
		JSON.stringify({
			userId: query.userId,
			archived: query.archived,
			search: query.search ?? null,
			...position,
		}),
	).toString("base64url");
}
export function decodeCursor(query: ListOptions): ListPosition | undefined {
	if (!query.cursor) return;
	try {
		const raw = Buffer.from(query.cursor, "base64url");
		if (raw.toString("base64url") !== query.cursor) throw new Error();
		const value = Cursor.parse(JSON.parse(raw.toString("utf8")));
		if (
			value.userId !== query.userId ||
			value.archived !== query.archived ||
			value.search !== (query.search ?? null)
		)
			throw new Error();
		return {
			conversationId: value.conversationId,
			lastActivityAt: value.lastActivityAt,
		};
	} catch {
		throw new InvalidCursor();
	}
}
export class InvalidCursor extends Error {}

export const SendBody = z.strictObject({
	text: z
		.string()
		.refine(
			(text) => text.trim().length > 0 && Buffer.byteLength(text) <= 32768,
		),
	requestId: z
		.string()
		.min(1)
		.refine((value) => Buffer.byteLength(value) <= 1020),
});

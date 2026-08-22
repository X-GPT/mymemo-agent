import { createMiddleware } from "hono/factory";
import type { AppEnv } from "@/deps";
import { InternalIdentity } from "./conversations.schema";

/** Parse and validate the identity forwarded by the trusted internal caller. */
function identityFromContext(c: {
	req: { header: (key: string) => string | undefined };
}) {
	return InternalIdentity.safeParse({
		memberCode: c.req.header("x-member-code"),
		memberName: c.req.header("x-member-name"),
		teamCode: c.req.header("x-team-code"),
		partnerCode: c.req.header("x-partner-code"),
		partnerName: c.req.header("x-partner-name"),
	});
}

export const requireInternalIdentity = createMiddleware<AppEnv>(
	async (c, next) => {
		const identity = identityFromContext(c);
		if (!identity.success) {
			return c.json(
				{ error: "Missing or invalid internal identity headers" },
				401,
			);
		}
		c.set("identity", identity.data);
		await next();
	},
);

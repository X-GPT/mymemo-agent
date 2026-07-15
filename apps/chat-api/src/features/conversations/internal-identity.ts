import { InternalIdentity } from "./conversations.schema";

/** Parse and validate the identity forwarded by the trusted internal caller. */
export function identityFromContext(c: {
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

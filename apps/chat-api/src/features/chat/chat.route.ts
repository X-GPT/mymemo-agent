import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { validator as zValidator } from "hono-openapi";
import type { AppEnv } from "@/deps";
import { ConversationBusyError } from "@/features/sandbox-orchestration";
import { complete } from "./chat.controller";
import { ChatLogger } from "./chat.logger";
import {
	ChatBodyRequest,
	InternalIdentity,
	MAX_REQUEST_BODY_BYTES,
} from "./chat.schema";
import { HonoSSESender } from "./chat.streaming";

const app = new Hono<AppEnv>();

app.post(
	"/",
	bodyLimit({
		maxSize: MAX_REQUEST_BODY_BYTES,
		onError: (c) => c.json({ error: "Request body too large" }, 413),
	}),
	zValidator("json", ChatBodyRequest, (result, c) => {
		if (!result.success) {
			console.warn({
				message: "Invalid request body",
				issues: result.error,
			});
			return c.json(
				{ error: "Invalid request body", issues: result.error },
				400,
			);
		}
	}),
	async (c) => {
		const body = c.req.valid("json");

		const identityResult = InternalIdentity.safeParse({
			memberCode: c.req.header("x-member-code"),
			memberName: c.req.header("x-member-name"),
			teamCode: c.req.header("x-team-code"),
			partnerCode: c.req.header("x-partner-code"),
			partnerName: c.req.header("x-partner-name"),
		});

		if (!identityResult.success) {
			c.var.logger.warn({
				message: "Missing or invalid internal identity headers",
				issues: identityResult.error.flatten(),
			});
			return c.json(
				{ error: "Missing or invalid internal identity headers" },
				401,
			);
		}

		const request = { ...body, ...identityResult.data };

		return streamSSE(
			c,
			async (stream) => {
				const sender = new HonoSSESender(stream);

				// Start keepalive ping interval (5 seconds)
				const keepaliveInterval = setInterval(() => {
					sender.sendPing().catch((err) => {
						c.var.logger.error({
							message: "Failed to send keepalive ping",
							error: err,
						});
					});
				}, 5000);

				try {
					await complete(
						c.var.deps,
						request,
						sender,
						new ChatLogger(c.var.logger, request.memberCode),
					);
				} catch (err) {
					if (err instanceof ConversationBusyError) {
						await sender.send({
							id: crypto.randomUUID(),
							message: {
								type: "error",
								message:
									"Sandbox is busy processing another request. Please try again shortly.",
							},
						});
						return;
					}
					throw err;
				} finally {
					// Always clear the interval when complete finishes
					clearInterval(keepaliveInterval);
				}
			},
			async (error, stream) => {
				c.var.logger.error({
					message: "Error in chat route",
					error,
				});
				// TODO: enrich error with more details
				const sender = new HonoSSESender(stream);
				await sender.send({
					id: crypto.randomUUID(),
					message: {
						type: "error",
						message: error.message,
					},
				});
			},
		);
	},
);

export default app;

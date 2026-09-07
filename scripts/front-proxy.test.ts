import { expect, test } from "bun:test";
import { Sha256 } from "@aws-crypto/sha256-js";
import { SignatureV4 } from "@smithy/signature-v4";
import { createProxy } from "./front-proxy";

test("proxy signs body, repeated query and trusted identity; relays the first chunk before EOF", async () => {
	let finish: (() => void) | undefined;
	const upstream = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			expect(request.headers.get("authorization")).toContain(
				"AWS4-HMAC-SHA256",
			);
			expect(request.headers.get("x-amz-content-sha256")).toHaveLength(64);
			expect(request.headers.get("x-member-code")).toBe("operator");
			expect(new URL(request.url).searchParams.getAll("q")).toEqual(["a", "b"]);
			expect(await request.text()).toBe('{"text":"hello"}');
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("first\n"));
						finish = () => controller.close();
					},
				}),
				{ headers: { "x-vercel-ai-ui-message-stream": "v1" } },
			);
		},
	});
	const proxy = createProxy(
		upstream.url,
		new SignatureV4({
			credentials: { accessKeyId: "test", secretAccessKey: "test" },
			region: "us-west-2",
			service: "lambda",
			sha256: Sha256,
		}),
		{ "x-member-code": "operator" },
		"http://localhost:3000",
	);
	try {
		expect(
			(
				await proxy(
					new Request("http://localhost/v1", {
						headers: { origin: "https://evil.example" },
					}),
				)
			).status,
		).toBe(403);
		const response = await proxy(
			new Request("http://localhost/v1?q=a&q=b", {
				method: "POST",
				body: '{"text":"hello"}',
				headers: {
					"x-member-code": "forged",
					"content-type": "application/json",
				},
			}),
		);
		expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
		if (!response.body) throw new Error("Missing response stream");
		const reader = response.body.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toBe(
			"first\n",
		);
		finish?.();
		finish = undefined;
		expect((await reader.read()).done).toBe(true);
	} finally {
		finish?.();
		upstream.stop(true);
	}
});

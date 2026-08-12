/**
 * The sandbox origin (#438).
 *
 * A Cloudflare Worker rather than a static page behind a Transform Rule: the
 * response headers *are* the security boundary here, so they belong in
 * versioned code that ships with the thing it protects, not in dashboard state
 * that can drift out from under it. A Worker also leaves room for the
 * server-side document composition #431 settled on, which a static bucket
 * could not serve.
 */

import { HOST_PAGE_HTML, SELF_SCRIPT_JS } from "./host-page";
import { SANDBOX_HEADERS } from "./policy";

export default {
	fetch(request: Request): Response {
		const { pathname } = new URL(request.url);

		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("method not allowed", { status: 405 });
		}

		if (pathname === "/" || pathname === "/index.html") {
			return new Response(HOST_PAGE_HTML, { headers: SANDBOX_HEADERS });
		}

		if (pathname === "/probe-self-script.js") {
			return new Response(SELF_SCRIPT_JS, {
				headers: {
					...SANDBOX_HEADERS,
					"content-type": "text/javascript; charset=utf-8",
				},
			});
		}

		return new Response("not found", { status: 404 });
	},
};

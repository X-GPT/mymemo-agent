/**
 * Local harness for exercising the envelope without deploying (#438).
 *
 * Serves the exact bytes and headers the Worker serves, on two ports, so the
 * cross-origin framing case is real: 8787 stands in for the sandbox origin and
 * 8788 for mymemo-web. Different ports are different origins, so the parent-DOM
 * and `frame-ancestors` checks behave as they will in production.
 *
 * What this cannot prove is Cloudflare-specific — that TLS provisions and that
 * the edge passes the header through untouched. Those need the real deploy.
 *
 *   bun infra/sandbox-origin/dev-server.ts
 */

import { HOST_PAGE_HTML, SELF_SCRIPT_JS } from "./src/host-page";
import { contentSecurityPolicy, SANDBOX_HEADERS } from "./src/policy";

const SANDBOX_PORT = 8787;
const EMBEDDER_PORT = 8788;

/** The harness's own embedder origin, added so `frame-ancestors` admits it locally. */
const LOCAL_CSP = contentSecurityPolicy([`http://localhost:${EMBEDDER_PORT}`]);
const LOCAL_HEADERS = {
	...SANDBOX_HEADERS,
	"content-security-policy": LOCAL_CSP,
};

Bun.serve({
	port: SANDBOX_PORT,
	fetch(request) {
		const url = new URL(request.url);
		const { pathname } = url;
		if (pathname === "/" || pathname === "/index.html") {
			// `?drop=frame-ancestors,sandbox` omits those directives, so the
			// envelope can be bisected a directive at a time.
			const drop = (url.searchParams.get("drop") ?? "")
				.split(",")
				.map((d) => d.trim())
				.filter(Boolean);
			const headers = { ...LOCAL_HEADERS };
			if (drop.length > 0) {
				headers["content-security-policy"] = LOCAL_CSP.split("; ")
					.filter((d) => !drop.some((name) => d.startsWith(name)))
					.join("; ");
			}
			return new Response(HOST_PAGE_HTML, { headers });
		}
		if (pathname === "/probe-self-script.js") {
			return new Response(SELF_SCRIPT_JS, {
				headers: {
					...LOCAL_HEADERS,
					"content-type": "text/javascript; charset=utf-8",
				},
			});
		}
		return new Response("not found", { status: 404 });
	},
});

/**
 * Stands in for mymemo-web. It writes a token into its own localStorage first,
 * so the frame's storage probe is testing against a credential that genuinely
 * exists on the embedding origin rather than against an empty store.
 */
const EMBEDDER_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>embedder (stands in for mymemo-web)</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:1rem}iframe{width:100%;height:70vh;border:1px solid #999;border-radius:6px}</style>
<script>
  // Set before the frame is parsed, so the credential is already there to steal.
  localStorage.setItem("ADMIN_SECRET_TOKEN", "fake-token-for-probe");
</script>
</head>
<body>
<p>Embedding <code>http://localhost:${SANDBOX_PORT}</code> cross-origin. This page holds a fake <code>ADMIN_SECRET_TOKEN</code> in localStorage for the frame to try to reach.</p>
<iframe src="http://localhost:${SANDBOX_PORT}/" sandbox="allow-scripts" title="sandbox"></iframe>
</body>
</html>`;

Bun.serve({
	port: EMBEDDER_PORT,
	fetch() {
		return new Response(EMBEDDER_HTML, {
			headers: { "content-type": "text/html; charset=utf-8" },
		});
	},
});

console.log(`sandbox  http://localhost:${SANDBOX_PORT}/`);
console.log(`embedder http://localhost:${EMBEDDER_PORT}/`);

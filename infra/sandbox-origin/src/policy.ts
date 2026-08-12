/**
 * Response headers for the sandbox origin.
 *
 * The sandbox origin serves model-authored HTML+JS (map #430). It is a
 * separate registrable domain from `mymemo.ai`, so no cookie, SameSite rule,
 * or future auth change can bridge into it. What this file adds on top of that
 * origin separation is the *egress* envelope: a payload that runs here must not
 * be able to send the bytes it was given anywhere.
 *
 * Baseline for provisioning (#438). #432 stresses it against real payloads and
 * #437 makes the final set normative.
 */

/**
 * Origins allowed to frame the sandbox document.
 *
 * `frame-ancestors` has no `default-src` fallback, so it is stated explicitly.
 * Localhost is present for mymemo-web development and must be dropped from the
 * production deployment.
 */
const FRAME_ANCESTORS = [
	"https://mymemo.ai",
	"https://www.mymemo.ai",
	"https://staging.mymemo.ai",
] as const;

/**
 * Every directive is host-free except `frame-ancestors` (inbound, not a
 * fetch source) and the `'self'`/`data:`/`blob:` subresource sources, which
 * cannot leave this origin.
 *
 * CSP's exfiltration ceiling is the *union* of all source lists (CSP3 §8.6):
 * a single external host token anywhere in this policy reopens egress. Adding
 * one is a contract change, not a tweak.
 */
function directives(extraFrameAncestors: readonly string[]): string[] {
	return [
		// Nothing loads unless a directive below says otherwise.
		"default-src 'none'",

		// Model-authored fragments carry inline <script> and <style>. A nonce
		// would disable 'unsafe-inline', and the script we most need to run is
		// exactly the untrusted one — so provenance is not what makes this safe.
		// The opaque origin and the no-egress source lists are.
		"script-src 'self' 'unsafe-inline'",
		"style-src 'self' 'unsafe-inline'",

		// MEASURED (2026-08-12, Chrome): under `sandbox allow-scripts` the
		// document's origin is opaque, so `'self'` matches NOTHING — same-origin
		// script, image and stylesheet loads are all blocked. `data:` and
		// `blob:` still work. The served runtime and every library must
		// therefore be INLINED into the composed document; they cannot be
		// fetched as files. `'self'` is retained only to state intent, and
		// starts working only if `allow-same-origin` is ever granted.
		// See docs/verification/sandbox-origin-envelope.md.
		"img-src 'self' data: blob:",
		"font-src 'self' data:",

		// The egress closures. `connect-src` covers fetch/XHR/WebSocket/
		// sendBeacon/EventSource. `form-action` and `base-uri` do NOT fall back
		// to `default-src`, so omitting them would leave two open channels.
		"connect-src 'none'",
		"form-action 'none'",
		"base-uri 'none'",

		// No nested browsing contexts, no plugins, no media, no workers.
		"object-src 'none'",
		"media-src 'none'",
		"frame-src 'none'",
		"child-src 'none'",
		"worker-src 'none'",
		"manifest-src 'none'",

		`frame-ancestors ${[...FRAME_ANCESTORS, ...extraFrameAncestors].join(" ")}`,

		// Enforced by the document's own response, so the envelope holds even if
		// an embedder forgets the iframe `sandbox` attribute. `allow-scripts`
		// alone forces an opaque origin: no cookies, no storage, and no shared
		// state between two payloads served from this same origin.
		//
		// Deliberately absent: `allow-same-origin` (would restore storage access
		// and defeat the opaque origin) and `allow-popups` (an unsandboxed popup
		// at an attacker URL is a direct exfiltration channel).
		"sandbox allow-scripts",
	];
}

/**
 * @param extraFrameAncestors additional embedder origins — the local harness
 * passes its own `http://localhost` origin. Never set in production.
 */
export function contentSecurityPolicy(
	extraFrameAncestors: readonly string[] = [],
): string {
	return directives(extraFrameAncestors).join("; ");
}

export const CONTENT_SECURITY_POLICY = contentSecurityPolicy();

export const SANDBOX_HEADERS: Record<string, string> = {
	"content-type": "text/html; charset=utf-8",
	"content-security-policy": CONTENT_SECURITY_POLICY,
	"x-content-type-options": "nosniff",
	// The sandbox document must never be indexed or cached by a shared cache.
	"referrer-policy": "no-referrer",
	"cache-control": "no-store",
	// Deny the ambient-capability APIs CSP does not cover.
	"permissions-policy": [
		"geolocation=()",
		"microphone=()",
		"camera=()",
		"payment=()",
		"usb=()",
		"midi=()",
		"serial=()",
		"bluetooth=()",
		"hid=()",
		"display-capture=()",
		"idle-detection=()",
		"local-fonts=()",
		"screen-wake-lock=()",
	].join(", "),
};

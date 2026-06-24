import type { LlmProviderName } from "../../env";

/**
 * A provider abstraction over the LLM upstream. The proxy stays provider-agnostic:
 * it verifies the token and normalizes the path, then asks the provider whether
 * the path is on its compatibility surface, how to build the upstream URL, and
 * which credentials/headers to inject. Only the provider knows its own auth
 * scheme and supported paths, so the upstream secret is set in exactly one place
 * (`authorizeUpstream`) and never leaks into the proxy or the response.
 */
export interface LlmProvider {
	/** Provider name, for logging and clear error messages. */
	readonly name: LlmProviderName;
	/**
	 * Whether this provider's Claude-SDK-compatibility surface supports the given
	 * normalized request path. Paths it cannot honor fail closed in the proxy
	 * (a clear 404) rather than being forwarded and erroring opaquely upstream.
	 */
	supportsPath(path: string): boolean;
	/** Build the upstream URL for a normalized path + raw query string. */
	upstreamUrl(path: string, search: string): string;
	/**
	 * Inject upstream credentials and provider-required headers onto the outgoing
	 * request, mutating `headers` in place. The upstream secret is only ever set
	 * here, on the request to the provider — never echoed back to the caller.
	 */
	authorizeUpstream(headers: Headers): void;
}

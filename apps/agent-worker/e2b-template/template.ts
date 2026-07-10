import { Template, type TemplateClass } from "e2b";

/**
 * The custom E2B sandbox template (Task 9.2). The agent's Grep/Glob tools
 * shell out to `rg` and `python3` inside the sandbox. E2B's stock `base`
 * template ships python3 (with git/curl/build tools) but no rg — every run
 * sandbox is created from this template instead, so the search tools work
 * identically in every sandbox.
 *
 * The toolchain is pinned so rebuilds are reproducible:
 * - the base image by digest — neither Docker Hub (a moving `latest` plus
 *   unversioned packaging-experiment tags) nor the SDK's fromBaseImage()
 *   (no version parameter) offers a versioned e2bdev/base reference,
 * - ripgrep by release version + sha256 of the published Debian package.
 *
 * Build with `bun run template:build`, then prove a sandbox created from it
 * runs `rg --version` and `python3 --version` with `bun run template:verify`
 * (the Task 9.2 acceptance check). See README.md for the deploy-flow slot.
 */

/** Default alias the template is built under and workers reference via
 * `WORKER_E2B_TEMPLATE`. */
export const TEMPLATE_NAME = "mymemo-agent-sandbox";

/** The image behind E2B's stock `base` template, pinned to the multi-arch
 * manifest digest of `latest` (2026-06-15). Bump deliberately: re-run
 * template:build + template:verify. */
export const BASE_IMAGE =
	"e2bdev/base@sha256:4a369f01a820fe5e65f53c2c5727a78899daf86f0541b721097f289559c8b73f";

export const RIPGREP_VERSION = "14.1.1";
/** sha256 of ripgrep_14.1.1-1_amd64.deb, from the release's published
 * .deb.sha256 asset. E2B sandboxes are x86_64, so amd64 is the only arch. */
export const RIPGREP_DEB_SHA256 =
	"2f0c732ef166b4f7be7190d4012d60b3f8467bdd6f795c0598817bd2ac1706ae";

const RIPGREP_DEB = `ripgrep_${RIPGREP_VERSION}-1_amd64.deb`;
const RIPGREP_DEB_URL = `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/${RIPGREP_DEB}`;

/** The template definition: base image + pinned rg install + a build-time
 * confirmation of the whole Grep/Glob toolchain (fails the build if the base
 * image ever drops python3). */
export function sandboxTemplate(): TemplateClass {
	return Template()
		.fromImage(BASE_IMAGE)
		.runCmd(
			[
				`curl -fsSL -o /tmp/${RIPGREP_DEB} ${RIPGREP_DEB_URL}`,
				`echo "${RIPGREP_DEB_SHA256}  /tmp/${RIPGREP_DEB}" | sha256sum -c -`,
				`dpkg -i /tmp/${RIPGREP_DEB}`,
				`rm /tmp/${RIPGREP_DEB}`,
			],
			{ user: "root" },
		)
		.runCmd("rg --version && python3 --version");
}

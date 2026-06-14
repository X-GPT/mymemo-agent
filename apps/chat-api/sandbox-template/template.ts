import { Template } from "e2b";

const WORKSPACE_ROOT = "/workspace";

export const template = Template()
	.fromNodeImage("24")
	.aptInstall(["curl", "git", "ripgrep", "lsof", "zstd", "unzip", "bubblewrap"])
	.runCmd("curl -fsSL https://bun.sh/install | bash")
	.runCmd("ln -s /home/user/.bun/bin/bun /usr/local/bin/bun", { user: "root" })
	// The agent's document access: a tiny CLI on PATH that forwards search/fetch
	// to the gateway's document routes with the per-turn token (MYMEMO_DOC_* env vars set
	// by the daemon). On PATH under `/`, so it's visible inside the agent's bwrap
	// (`--ro-bind / /`). Holds no credential itself.
	.copy("mymemo-docs", "/usr/local/bin/mymemo-docs", {
		mode: 0o755,
		user: "root",
	})
	.setWorkdir(WORKSPACE_ROOT)
	.runCmd(`mkdir -p ${WORKSPACE_ROOT}/data`);

import { apiEnv } from "@/config/env";
import { E2BSandboxProvider } from "./e2b-sandbox-provider";
import { LocalContainerSandboxProvider } from "./local-container-sandbox-provider";
import type { SandboxProvider } from "./sandbox-provider";

// Select the provider once at module load. `local` targets the docker-compose
// E2E harness (a long-lived daemon container); the default `e2b` leases a fresh
// sandbox per turn in production.
export const sandboxProvider: SandboxProvider =
	apiEnv.SANDBOX_PROVIDER === "local"
		? new LocalContainerSandboxProvider()
		: new E2BSandboxProvider();

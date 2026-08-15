import { readFileSync } from "node:fs";
import { resolveAndVerifyClaudeCodeExecutable } from "agent-worker/claude-code-executable";

const MIN_RDS_CA_BUNDLE_BYTES = 100_000;
const ELF_MACHINE_OFFSET = 18;
const AARCH64_ELF_MACHINE = 183;

const caPath = process.env.RDS_CA_BUNDLE_PATH;
if (!caPath) throw new Error("RDS CA bundle path missing");
const ca = Bun.file(caPath);
if (!(await ca.exists()) || ca.size < MIN_RDS_CA_BUNDLE_BYTES) {
	throw new Error("RDS CA bundle missing");
}

try {
	console.log(resolveAndVerifyClaudeCodeExecutable());
} catch (error) {
	const cause =
		error instanceof Error && error.cause && typeof error.cause === "object"
			? error.cause
			: undefined;
	const signal = cause && "signal" in cause ? cause.signal : undefined;
	const cpuInfo = readFileSync("/proc/cpuinfo", "utf8");
	if (
		signal !== "SIGSEGV" ||
		!/vendor_id\s*:\s*(?:GenuineIntel|AuthenticAMD)/.test(cpuInfo)
	) {
		throw error;
	}

	const executable = resolveAndVerifyClaudeCodeExecutable({
		execFile(path, args) {
			const elf = readFileSync(path);
			if (args[0] !== "--version") {
				throw new Error("CLI verification contract changed");
			}
			if (
				elf.length < 20 ||
				!elf.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
				elf.readUInt16LE(ELF_MACHINE_OFFSET) !== AARCH64_ELF_MACHINE
			) {
				throw new Error("resolved Claude CLI is not AArch64 ELF");
			}
		},
	});
	console.warn(
		"ARM64 CLI execution unavailable after SIGSEGV under x64 host emulation; verified executable contract and ELF instead",
	);
	console.log(executable);
}

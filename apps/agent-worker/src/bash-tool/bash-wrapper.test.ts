import { describe, expect, it } from "bun:test";
import {
	buildKillGroupCommand,
	buildReapCommand,
	controlFilePath,
	DEFAULT_COMMAND_CONTROL_DIR,
	parseReapSurvivors,
	WRAPPER_PROGRAM,
	wrapperEnv,
} from "./bash-wrapper";

describe("bash wrapper program", () => {
	it("runs the command as a fresh session leader and records the group id", () => {
		// setsid gives the command its own process group; the inner shell writes
		// its pid (the group id) before exec'ing the user command.
		expect(WRAPPER_PROGRAM).toContain("setsid sh -c");
		expect(WRAPPER_PROGRAM).toContain('echo $$ > "$0"');
		expect(WRAPPER_PROGRAM).toContain('exec sh -c "$1"');
	});

	it("signals the whole process group, not just the leader pid", () => {
		// The negative pgid is the load-bearing detail the spike proved necessary.
		expect(WRAPPER_PROGRAM).toContain('kill -TERM "-$pgid"');
		expect(WRAPPER_PROGRAM).toContain('kill -KILL "-$pgid"');
		expect(WRAPPER_PROGRAM).toContain("trap forward TERM INT");
	});

	it("re-exits with the command's own status", () => {
		expect(WRAPPER_PROGRAM).toContain('wait "$child"');
		expect(WRAPPER_PROGRAM).toContain("code=$?");
		expect(WRAPPER_PROGRAM).toContain('exit "$code"');
	});

	it("passes the user command as data, never as executed shell text", () => {
		const env = wrapperEnv({
			command: "rm -rf / # hostile",
			commandId: "cmd-1",
			controlDir: DEFAULT_COMMAND_CONTROL_DIR,
		});
		expect(env.MYMEMO_CMD).toBe("rm -rf / # hostile");
		expect(env.MYMEMO_CMD_ID).toBe("cmd-1");
		expect(env.MYMEMO_CONTROL_DIR).toBe(DEFAULT_COMMAND_CONTROL_DIR);
		// The program body must not interpolate the command itself.
		expect(WRAPPER_PROGRAM).not.toContain("rm -rf");
	});
});

describe("controlFilePath", () => {
	it("keeps control files out of any workspace", () => {
		expect(controlFilePath("cmd-9", DEFAULT_COMMAND_CONTROL_DIR)).toBe(
			"/tmp/mymemo-commands/cmd-9.pgid",
		);
	});
});

describe("buildKillGroupCommand", () => {
	it("sends TERM then KILL to the group with a grace period", () => {
		const script = buildKillGroupCommand({
			commandId: "cmd-2",
			controlDir: DEFAULT_COMMAND_CONTROL_DIR,
			graceMs: 2000,
		});
		expect(script).toContain("'/tmp/mymemo-commands/cmd-2.pgid'");
		expect(script).toContain('kill -TERM "-$pgid"');
		expect(script).toContain("sleep 2");
		expect(script).toContain('kill -KILL "-$pgid"');
	});
});

describe("buildReapCommand", () => {
	it("force-kills the group and prints the survivor count", () => {
		const script = buildReapCommand({
			commandId: "cmd-3",
			controlDir: DEFAULT_COMMAND_CONTROL_DIR,
		});
		expect(script).toContain('kill -KILL "-$pgid"');
		expect(script).toContain("ps -eo pgid=,stat=");
		expect(script).toContain("printf");
	});
});

describe("parseReapSurvivors", () => {
	it("reads the trailing count", () => {
		expect(parseReapSurvivors("0\n")).toBe(0);
		expect(parseReapSurvivors("noise\n3\n")).toBe(3);
	});

	it("treats unparseable output as a survivor so ambiguity taints", () => {
		expect(parseReapSurvivors("")).toBe(1);
		expect(parseReapSurvivors("what\n")).toBe(1);
	});
});

import { expect, test } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("bootstrap checker checks every service and rejects denied or incomplete simulations", () => {
	const dir = mkdtempSync(join(tmpdir(), "bootstrap-iam-"));
	try {
		const aws = join(dir, "aws");
		writeFileSync(
			aws,
			`#!/usr/bin/env bash
set -eu
[[ "$1 $2" == "--profile mymemo" ]]
shift 2
case "$1 $2" in
  'sts get-caller-identity') echo 637423444544 ;;
  'iam simulate-principal-policy')
    printf '%s\\n' "$*" >> "$CHECK_LOG"
    while [[ "$1" != --action-names ]]; do shift; done
    shift
    actions=()
    while [[ "$1" != --output ]]; do actions+=("$1"); shift; done
    printf '%s\\n' "\${actions[@]}" | jq -Rn --arg mode "$CHECK_MODE" \
      '{EvaluationResults: ([inputs | {EvalDecision: (if $mode == "denied" then "implicitDeny" else "allowed" end), MissingContextValues: (if $mode == "missing" then ["key"] else [] end)}] | if $mode == "empty" then [] else . end)}' ;;
  'iam list-attached-role-policies') echo '{"AttachedPolicies":[]}' ;;
  'iam list-role-policies') echo '{"PolicyNames":["legacy"]}' ;;
  *) exit 9 ;;
esac
`,
		);
		chmodSync(aws, 0o755);
		for (const mode of ["allowed", "denied", "missing", "empty"]) {
			const log = join(dir, `${mode}.log`);
			const result = Bun.spawnSync({
				cmd: ["bash", "scripts/deploy/check_simplified_chat_iam.sh"],
				env: {
					...process.env,
					PATH: `${dir}:${process.env.PATH}`,
					CHECK_MODE: mode,
					CHECK_LOG: log,
				},
			});
			expect(result.exitCode === 0).toBe(mode === "allowed");
			if (mode === "allowed") {
				const calls = readFileSync(log, "utf8");
				for (const action of [
					"dynamodb:CreateTable",
					"lambda:CreateFunctionUrlConfig",
					"bedrock-agentcore:CreateCodeInterpreter",
					"scheduler:CreateSchedule",
					"s3:PutBucketPolicy",
					"iam:PassRole",
					"logs:CreateLogGroup",
					"bedrock-agentcore:CreateAgentRuntime",
				]) {
					expect(calls).toContain(action);
				}
			} else {
				expect(result.stdout.toString()).not.toContain(
					"All grant simulations passed",
				);
			}
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

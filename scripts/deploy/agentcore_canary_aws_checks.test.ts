import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const checksPath = join(import.meta.dir, "agentcore_canary_aws_checks.sh");
const queueArn = "arn:aws:sqs:us-west-2:637423444544:canary-dispatch";
const consumerArn =
	"arn:aws:lambda:us-west-2:637423444544:function:canary-consumer";
const publisherArn =
	"arn:aws:lambda:us-west-2:637423444544:function:canary-publisher";
const ruleArn = "arn:aws:events:us-west-2:637423444544:rule/canary-repair";

const terraformOutput = JSON.stringify({
	consumer_event_source_mapping_uuid: { value: "mapping-1" },
	repair_rule_name: { value: "canary-repair" },
	repair_rule_arn: { value: ruleArn },
	dispatch_queue_arn: { value: queueArn },
	consumer_function_arn: { value: consumerArn },
	publisher_function_arn: { value: publisherArn },
	enabled_parameter_name: { value: "/canary/enabled" },
});

interface LiveWiring {
	mapping: Record<string, unknown>;
	consumer: Record<string, unknown>;
	rule: Record<string, unknown>;
	targets: Record<string, unknown>;
	permission: Record<string, unknown>;
}

function expectedWiring(): LiveWiring {
	return {
		mapping: {
			BatchSize: 1,
			State: "Disabled",
			EventSourceArn: queueArn,
			FunctionArn: consumerArn,
			FunctionResponseTypes: ["ReportBatchItemFailures"],
		},
		consumer: { FunctionArn: consumerArn, Timeout: 120 },
		rule: {
			Arn: ruleArn,
			State: "DISABLED",
			ScheduleExpression: "rate(1 minute)",
		},
		targets: {
			Targets: [{ Arn: publisherArn, Id: "shared-publisher" }],
		},
		permission: {
			Policy: JSON.stringify({
				Version: "2012-10-17",
				Statement: [
					{
						Sid: "AllowEventBridgeRepair",
						Effect: "Allow",
						Principal: { Service: "events.amazonaws.com" },
						Action: "lambda:InvokeFunction",
						Resource: publisherArn,
						Condition: { ArnLike: { "AWS:SourceArn": ruleArn } },
					},
				],
			}),
		},
	};
}

function verify(wiring: LiveWiring) {
	const script = `
set -euo pipefail
source "${checksPath}"
aws() {
  case "$*" in
    *"lambda get-event-source-mapping"*) printf '%s\n' "$MAPPING" ;;
    *"lambda get-function-configuration"*) printf '%s\n' "$CONSUMER" ;;
    *"lambda get-function-concurrency"*) printf '%s\n' "1" ;;
    *"events describe-rule"*) printf '%s\n' "$RULE" ;;
    *"events list-targets-by-rule"*) printf '%s\n' "$TARGETS" ;;
    *"lambda get-policy"*) printf '%s\n' "$PERMISSION" ;;
    *"ssm get-parameter"*) printf '%s\n' "disabled" ;;
    *) exit 97 ;;
  esac
}
verify_agentcore_canary_disabled_dispatch us-west-2 "$TF_OUTPUT"
`;
	return spawnSync("bash", ["-c", script], {
		encoding: "utf8",
		env: {
			...process.env,
			TF_OUTPUT: terraformOutput,
			MAPPING: JSON.stringify(wiring.mapping),
			CONSUMER: JSON.stringify(wiring.consumer),
			RULE: JSON.stringify(wiring.rule),
			TARGETS: JSON.stringify(wiring.targets),
			PERMISSION: JSON.stringify(wiring.permission),
		},
	});
}

describe("AgentCore live disabled-dispatch wiring", () => {
	it("accepts the complete Terraform-owned repair and consumer graph", () => {
		const result = verify(expectedWiring());
		expect(result.status, result.stderr).toBe(0);
	});

	it.each([
		[
			"queue binding",
			(wiring: LiveWiring) => {
				wiring.mapping.EventSourceArn = `${queueArn}-foreign`;
			},
		],
		[
			"consumer binding",
			(wiring: LiveWiring) => {
				wiring.mapping.FunctionArn = `${consumerArn}-foreign`;
			},
		],
		[
			"repair target",
			(wiring: LiveWiring) => {
				wiring.targets = {
					Targets: [{ Arn: `${publisherArn}-foreign`, Id: "shared-publisher" }],
				};
			},
		],
		[
			"repair permission source",
			(wiring: LiveWiring) => {
				const policy = JSON.parse(String(wiring.permission.Policy));
				policy.Statement[0].Condition.ArnLike["AWS:SourceArn"] =
					`${ruleArn}-foreign`;
				wiring.permission.Policy = JSON.stringify(policy);
			},
		],
	] as const)("rejects a mismatched %s", (_name, mutate) => {
		const wiring = expectedWiring();
		mutate(wiring);
		expect(verify(wiring).status).not.toBe(0);
	});
});

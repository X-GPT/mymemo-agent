import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const checksPath = join(import.meta.dir, "agentcore_aws_checks.sh");
const queueArn =
	"arn:aws:sqs:us-west-2:637423444544:mymemo-agent-agentcore-prod-dispatch";
const consumerArn =
	"arn:aws:lambda:us-west-2:637423444544:function:mymemo-agent-agentcore-prod-consumer";

const terraformOutput = JSON.stringify({
	consumer_event_source_mapping_uuid: { value: "mapping-1" },
	dispatch_queue_arn: { value: queueArn },
	consumer_function_arn: { value: consumerArn },
	dispatch_enabled_parameter_name: {
		value: "/mymemo/agentcore-dispatch/prod/enabled",
	},
});

interface AlarmConfiguration {
	namespace: string;
	metric_name: string;
	dimensions: Record<string, string>;
	statistic: string;
	period: number;
	evaluation_periods: number;
	datapoints_to_alarm: number;
	comparison_operator: string;
	threshold: number;
	treat_missing_data: string;
	actions_enabled: boolean;
	alarm_actions: string[];
}

const alarmConfigurations: Record<string, AlarmConfiguration> = {
	"mymemo-agent-agentcore-prod-pending-publication-age": {
		namespace: "MyMemo/AgentCoreDispatch",
		metric_name: "PendingAgeMs",
		dimensions: {},
		statistic: "Maximum",
		period: 60,
		evaluation_periods: 1,
		datapoints_to_alarm: 1,
		comparison_operator: "GreaterThanOrEqualToThreshold",
		threshold: 60000,
		treat_missing_data: "notBreaching",
		actions_enabled: true,
		alarm_actions: ["arn:aws:sns:us-west-2:637423444544:production-alerts"],
	},
	"mymemo-agent-agentcore-prod-publisher-errors": {
		namespace: "MyMemo/AgentCoreDispatch",
		metric_name: "PublisherErrors",
		dimensions: {},
		statistic: "Sum",
		period: 60,
		evaluation_periods: 5,
		datapoints_to_alarm: 3,
		comparison_operator: "GreaterThanOrEqualToThreshold",
		threshold: 1,
		treat_missing_data: "notBreaching",
		actions_enabled: true,
		alarm_actions: ["arn:aws:sns:us-west-2:637423444544:production-alerts"],
	},
};

interface LiveWiring {
	mapping: Record<string, unknown>;
	consumer: Record<string, unknown>;
	concurrency: Record<string, unknown>;
}

function expectedWiring(): LiveWiring {
	return {
		mapping: {
			BatchSize: 1,
			State: "Enabled",
			EventSourceArn: queueArn,
			FunctionArn: consumerArn,
			FunctionResponseTypes: ["ReportBatchItemFailures"],
		},
		consumer: { FunctionArn: consumerArn, Timeout: 120 },
		concurrency: {},
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
    *"lambda get-function-concurrency"*) printf '%s\n' "$CONCURRENCY" ;;
    *"ssm get-parameter"*) printf '%s\n' "disabled" ;;
    *) exit 97 ;;
  esac
}
verify_agentcore_idle_dispatch us-west-2 "$TF_OUTPUT"
`;
	return spawnSync("bash", ["-c", script], {
		encoding: "utf8",
		env: {
			...process.env,
			TF_OUTPUT: terraformOutput,
			MAPPING: JSON.stringify(wiring.mapping),
			CONSUMER: JSON.stringify(wiring.consumer),
			CONCURRENCY: JSON.stringify(wiring.concurrency),
		},
	});
}

function verifyAlarms(liveConfigurations: Record<string, AlarmConfiguration>) {
	const alarms = Object.entries(liveConfigurations).map(
		([AlarmName, configuration]) => ({
			AlarmName,
			Namespace: configuration.namespace,
			MetricName: configuration.metric_name,
			Dimensions: Object.entries(configuration.dimensions).map(
				([Name, Value]) => ({ Name, Value }),
			),
			Statistic: configuration.statistic,
			Period: configuration.period,
			EvaluationPeriods: configuration.evaluation_periods,
			DatapointsToAlarm: configuration.datapoints_to_alarm,
			ComparisonOperator: configuration.comparison_operator,
			Threshold: configuration.threshold,
			TreatMissingData: configuration.treat_missing_data,
			ActionsEnabled: configuration.actions_enabled,
			AlarmActions: [...configuration.alarm_actions].reverse(),
		}),
	);
	const script = `
set -euo pipefail
source "${checksPath}"
aws() {
  case "$*" in
    *"cloudwatch describe-alarms"*) printf '%s\\n' "$ALARMS" ;;
    *) exit 97 ;;
  esac
}
verify_agentcore_alarms us-west-2 "$TF_OUTPUT"
`;
	return spawnSync("bash", ["-c", script], {
		encoding: "utf8",
		env: {
			...process.env,
			TF_OUTPUT: JSON.stringify({
				alarm_configurations: { value: alarmConfigurations },
			}),
			ALARMS: JSON.stringify({ MetricAlarms: alarms }),
		},
	});
}

describe("production AgentCore idle dispatch wiring", () => {
	it("accepts the enabled consumer and fail-closed SSM graph", () => {
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
			"reserved concurrency",
			(wiring: LiveWiring) => {
				wiring.concurrency.ReservedConcurrentExecutions = 1;
			},
		],
	] as const)("rejects a mismatched %s", (_name, mutate) => {
		const wiring = expectedWiring();
		mutate(wiring);
		expect(verify(wiring).status).not.toBe(0);
	});
});

describe("production AgentCore alarm configuration", () => {
	it("accepts the complete Terraform-owned paging invariant", () => {
		const result = verifyAlarms(alarmConfigurations);
		expect(result.status, result.stderr).toBe(0);
	});

	it.each([
		[
			"metric namespace",
			"mymemo-agent-agentcore-prod-pending-publication-age",
			"namespace",
			"AWS/Lambda",
		],
		[
			"alarm datapoints",
			"mymemo-agent-agentcore-prod-publisher-errors",
			"datapoints_to_alarm",
			1,
		],
		[
			"alarm action",
			"mymemo-agent-agentcore-prod-publisher-errors",
			"alarm_actions",
			[],
		],
	] as const)("rejects a mismatched %s", (_name, alarmName, field, value) => {
		const configurations = structuredClone(alarmConfigurations);
		Object.assign(configurations[alarmName], { [field]: value });
		expect(verifyAlarms(configurations).status).not.toBe(0);
	});
});

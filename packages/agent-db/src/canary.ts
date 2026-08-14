export const CANARY_CAMPAIGN_LIFECYCLES = [
	"preparing",
	"provisioning",
	"running",
	"cleaning",
	"complete",
] as const;

export type CanaryCampaignLifecycle =
	(typeof CANARY_CAMPAIGN_LIFECYCLES)[number];

export const CANARY_VERDICTS = [
	"pass_for_rollout_review",
	"fail",
	"inconclusive",
] as const;

export type CanaryVerdict = (typeof CANARY_VERDICTS)[number];

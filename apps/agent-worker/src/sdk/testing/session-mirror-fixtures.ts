import type { ArtifactAwareQuery } from "../../artifacts/artifact-publication";
import type { SupervisedQuery } from "../agent-stream";
import type { RunQuery } from "../run-processor";
import type { SessionMirrorEvidence } from "../session-store";

export const noSessionMirrorEvidence: SessionMirrorEvidence = {
	mirroredMainSessionId: () => null,
};

export function withNoSessionMirrorEvidence(
	query: SupervisedQuery & Partial<ArtifactAwareQuery>,
): RunQuery {
	return Object.assign(query, { sessionEvidence: noSessionMirrorEvidence });
}

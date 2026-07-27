import {
	type ArtifactAwareQuery,
	withArtifactPublication,
} from "../../artifacts/artifact-publication";
import type { SupervisedQuery } from "../agent-stream";
import type { RunQuery } from "../run-processor";
import type { SessionMirrorEvidence } from "../session-store";

export const noSessionMirrorEvidence: SessionMirrorEvidence = {
	mirroredMainSessionId: () => null,
};

export function withNoSessionMirrorEvidence(
	query: SupervisedQuery & Partial<ArtifactAwareQuery>,
): RunQuery {
	return withSessionEvidence(query, noSessionMirrorEvidence);
}

export function withSessionMirrorEvidence(
	query: SupervisedQuery & Partial<ArtifactAwareQuery>,
	sessionId: string,
): RunQuery {
	return withSessionEvidence(query, {
		mirroredMainSessionId: () => sessionId,
	});
}

function withSessionEvidence(
	query: SupervisedQuery & Partial<ArtifactAwareQuery>,
	sessionEvidence: SessionMirrorEvidence,
): RunQuery {
	const artifactAwareQuery =
		query.getArtifactPublication === undefined
			? withArtifactPublication(query, { publish: async () => null })
			: (query as ArtifactAwareQuery);
	return {
		forceCloseSignal: artifactAwareQuery.forceCloseSignal,
		interrupt: () => artifactAwareQuery.interrupt(),
		close: () => artifactAwareQuery.close(),
		getArtifactPublication: () => artifactAwareQuery.getArtifactPublication(),
		sessionEvidence,
		[Symbol.asyncIterator]: () => artifactAwareQuery[Symbol.asyncIterator](),
	};
}

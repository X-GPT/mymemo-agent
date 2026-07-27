import type { ArtifactAwareQuery } from "../../artifacts/artifact-publication";
import type { RunQuery } from "../run-processor";
import type { SessionMirrorEvidence } from "../session-store";

export const noSessionMirrorEvidence: SessionMirrorEvidence = {
	mirroredMainSessionId: () => null,
};

export function withNoSessionMirrorEvidence(
	query: ArtifactAwareQuery,
): RunQuery {
	return withSessionEvidence(query, noSessionMirrorEvidence);
}

export function withSessionMirrorEvidence(
	query: ArtifactAwareQuery,
	sessionId: string,
): RunQuery {
	return withSessionEvidence(query, {
		mirroredMainSessionId: () => sessionId,
	});
}

function withSessionEvidence(
	query: ArtifactAwareQuery,
	sessionEvidence: SessionMirrorEvidence,
): RunQuery {
	return {
		forceCloseSignal: query.forceCloseSignal,
		interrupt: () => query.interrupt(),
		close: () => query.close(),
		getArtifactPublication: () => query.getArtifactPublication(),
		sessionEvidence,
		[Symbol.asyncIterator]: () => query[Symbol.asyncIterator](),
	};
}

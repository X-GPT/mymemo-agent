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
	return new Proxy(artifactAwareQuery, {
		get(target, property) {
			if (property === "sessionEvidence") return sessionEvidence;
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as RunQuery;
}

export class SandboxCreationError extends Error {
	override name = "SandboxCreationError" as const;
}

export class ConversationBusyError extends Error {
	override name = "ConversationBusyError" as const;
}

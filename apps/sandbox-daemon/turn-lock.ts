/**
 * Single-slot concurrency guard for agent turns.
 * Only one turn can run at a time per daemon instance.
 */

let currentTurnId: string | null = null;

export function acquireTurn(turnId: string): { release: () => void } | null {
	if (currentTurnId !== null) {
		return null;
	}

	currentTurnId = turnId;
	const release = () => {
		if (currentTurnId === turnId) {
			currentTurnId = null;
		}
	};

	return { release };
}

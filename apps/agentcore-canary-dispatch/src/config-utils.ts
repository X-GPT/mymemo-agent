export type Env = Record<string, string | undefined>;

export function requireEnv(env: Env, name: string): string {
	const value = env[name];
	if (!value || value.trim() === "") throw new Error(`${name} is required`);
	return value;
}

export function createRetryableAsyncSingleton<T>(
	create: () => Promise<T>,
): () => Promise<T> {
	let current: Promise<T> | undefined;
	return async () => {
		current ??= create();
		const attempt = current;
		try {
			return await attempt;
		} catch (error) {
			if (current === attempt) current = undefined;
			throw error;
		}
	};
}

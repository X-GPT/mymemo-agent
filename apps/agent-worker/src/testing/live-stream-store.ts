import type { LiveStreamStore } from "@mymemo/live-text";

export function fakeLiveStreamStore(
	overrides: Partial<LiveStreamStore> = {},
): LiveStreamStore {
	return {
		async acquire() {
			return "producer";
		},
		async append() {},
		async finalize() {},
		async refresh() {
			return true;
		},
		async appendWithRetryId() {
			return { cursor: "1-0", appended: true };
		},
		async *read() {},
		async status() {
			return "streaming";
		},
		async delete() {},
		async close() {},
		...overrides,
	};
}

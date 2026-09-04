const MAX_RETAINED_FRAMES = 3;
const MAX_RETAINED_BYTES = 64 * 1024 * 1024;

type Entry = {
	bytes: number;
	clear: () => void;
};

export const makeRetainedVideoFrameBudget = () => {
	const entries = new Map<object, Entry>();
	let retainedBytes = 0;

	const release = (key: object) => {
		const entry = entries.get(key);
		if (!entry) {
			return;
		}

		entries.delete(key);
		retainedBytes -= entry.bytes;
	};

	return {
		retain: ({
			key,
			bytes,
			clear,
		}: {
			key: object;
			bytes: number;
			clear: () => void;
		}) => {
			release(key);
			if (bytes > MAX_RETAINED_BYTES) {
				return false;
			}

			entries.set(key, {bytes, clear});
			retainedBytes += bytes;
			for (;;) {
				if (
					entries.size <= MAX_RETAINED_FRAMES &&
					retainedBytes <= MAX_RETAINED_BYTES
				) {
					break;
				}

				const oldest = entries.entries().next().value;
				if (!oldest) {
					break;
				}

				const [oldestKey, oldestEntry] = oldest;
				release(oldestKey);
				oldestEntry.clear();
			}

			return entries.has(key);
		},
		release,
		getUsage: () => ({frames: entries.size, bytes: retainedBytes}),
		dispose: () => {
			const current = Array.from(entries.values());
			entries.clear();
			retainedBytes = 0;
			for (const entry of current) {
				entry.clear();
			}
		},
	};
};

export type RetainedVideoFrameBudget = ReturnType<
	typeof makeRetainedVideoFrameBudget
>;

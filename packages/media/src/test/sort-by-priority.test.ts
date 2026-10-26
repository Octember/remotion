import {expect, test} from 'vitest';
import {processNext, waitForTurn} from '../audio/sort-by-priority';

test.each(['resolve', 'reject'])(
	'does not deliver a stale running waiter after it later %ss',
	async (outcome) => {
		const events: string[] = [];
		let firstPriority: number | null = 0;
		const first = {
			settle: null as (() => void) | null,
		};
		const second = {
			resolve: null as (() => void) | null,
		};

		waitForTurn({
			getPriority: () => firstPriority,
			fn: () =>
				new Promise<string>((resolve, reject) => {
					first.settle = () => {
						if (outcome === 'resolve') {
							resolve('first');
						} else {
							reject(new Error('late decode failure'));
						}
					};
				}),
			onDone: () => {
				events.push('first done');
			},
			onError: () => {
				events.push('first error');
			},
		});

		await expect.poll(() => first.settle).not.toBeNull();
		firstPriority = null;

		waitForTurn({
			getPriority: () => 0,
			fn: () =>
				new Promise<void>((resolve) => {
					second.resolve = resolve;
				}),
			onDone: () => {
				events.push('second done');
			},
			onError: () => {
				events.push('second error');
			},
		});

		await expect.poll(() => second.resolve).not.toBeNull();

		if (!first.settle) {
			throw new Error('First waiter did not start');
		}

		first.settle();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(events).toEqual([]);
		second.resolve?.();
		await expect.poll(() => events).toEqual(['second done']);

		expect(events).toEqual(['second done']);
	},
);

test('reevaluates priority and leaves jobs beyond the scheduling horizon waiting', async () => {
	const events: string[] = [];
	let priority = 3;
	waitForTurn({
		getPriority: () => priority,
		fn: () => {
			events.push('later');
			return Promise.resolve();
		},
		onDone: () => undefined,
		onError: (error) => {
			throw error;
		},
	});
	waitForTurn({
		getPriority: () => 0,
		fn: () => {
			events.push('now');
			return Promise.resolve();
		},
		onDone: () => undefined,
		onError: (error) => {
			throw error;
		},
	});
	await expect.poll(() => events).toEqual(['now']);
	priority = 1;
	processNext();
	await expect.poll(() => events).toEqual(['now', 'later']);
});

test.each(['throw', 'reject'])(
	'a decode that %ss frees the slot for the next decode',
	async (failure) => {
		const events: string[] = [];
		waitForTurn({
			getPriority: () => 0,
			fn: () => {
				if (failure === 'throw') {
					throw new Error('decode failed');
				}

				return Promise.reject(new Error('decode failed'));
			},
			onDone: () => {
				events.push('unexpected');
			},
			onError: () => {
				events.push('failed');
			},
		});
		waitForTurn({
			getPriority: () => 0,
			fn: () => Promise.resolve('decoded'),
			onDone: (value) => {
				events.push(value);
			},
			onError: (error) => {
				throw error;
			},
		});
		await expect.poll(() => events).toEqual(['failed', 'decoded']);
	},
);

test('serializes live decodes and chooses the nearest waiting deadline', async () => {
	const events: string[] = [];
	const pending = {resolve: null as (() => void) | null};
	waitForTurn({
		getPriority: () => 0,
		fn: () =>
			new Promise<void>((resolve) => {
				pending.resolve = resolve;
			}),
		onDone: () => {
			events.push('first');
		},
		onError: (error) => {
			throw error;
		},
	});
	await expect.poll(() => pending.resolve).not.toBeNull();
	for (const priority of [1, 0.5]) {
		waitForTurn({
			getPriority: () => priority,
			fn: () => {
				events.push(String(priority));
				return Promise.resolve();
			},
			onDone: () => undefined,
			onError: (error) => {
				throw error;
			},
		});
	}

	expect(events).toEqual([]);
	pending.resolve?.();
	await expect.poll(() => events).toEqual(['first', '0.5', '1']);
});

test('finishes completion callbacks before choosing the next waiting deadline', async () => {
	const events: string[] = [];
	let priority: number | null = 0;
	const enqueue = (name: string, deadline: number) => {
		waitForTurn({
			getPriority: () => deadline,
			fn: () => {
				events.push(name);
				return Promise.resolve();
			},
			onDone: () => undefined,
			onError: (error) => {
				throw error;
			},
		});
	};

	waitForTurn({
		getPriority: () => priority,
		fn: () => Promise.resolve(),
		onDone: () => {
			events.push('callback start');
			priority = null;
			enqueue('later', 1);
			enqueue('urgent', 0);
			events.push('callback end');
		},
		onError: (error) => {
			throw error;
		},
	});
	await expect
		.poll(() => events)
		.toEqual(['callback start', 'callback end', 'urgent', 'later']);
});

test.each(['enqueues', 'reprioritizes'])(
	'includes work that stale cleanup %s when choosing the next deadline',
	async (change) => {
		const events: string[] = [];
		let armed = false;
		let urgent = false;
		const enqueueUrgent = () => {
			waitForTurn({
				getPriority: () => (urgent ? 0 : 3),
				fn: () => Promise.resolve(),
				onDone: () => {
					events.push('urgent');
				},
				onError: (error) => {
					throw error;
				},
			});
		};

		waitForTurn({
			getPriority: () => (armed ? null : 3),
			fn: () => Promise.resolve(),
			onDone: () => {
				events.push('stale');
			},
			onError: () => {
				urgent = true;
				if (change === 'enqueues') {
					enqueueUrgent();
				}
			},
		});
		waitForTurn({
			getPriority: () => (armed ? 1 : 3),
			fn: () => Promise.resolve(),
			onDone: () => {
				events.push('regular');
			},
			onError: (error) => {
				throw error;
			},
		});
		if (change === 'reprioritizes') {
			enqueueUrgent();
		}

		armed = true;
		processNext();
		await expect.poll(() => events).toEqual(['urgent', 'regular']);
	},
);

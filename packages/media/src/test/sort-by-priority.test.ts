import {expect, test} from 'vitest';
import {processNext, waitForTurn} from '../audio/sort-by-priority';

test('does not resolve a running waiter after it got cancelled for being stale', async () => {
	const events: string[] = [];
	let firstPriority: number | null = 0;
	const first = {
		resolve: null as ((value: string) => void) | null,
	};

	waitForTurn({
		getPriority: () => firstPriority,
		fn: () =>
			new Promise<string>((resolve) => {
				first.resolve = resolve;
			}),
		onDone: () => {
			events.push('first done');
		},
		onError: () => {
			events.push('first error');
		},
	});

	await expect.poll(() => first.resolve).not.toBeNull();
	firstPriority = null;

	waitForTurn({
		getPriority: () => 0,
		fn: () => Promise.resolve('second'),
		onDone: () => {
			events.push('second done');
		},
		onError: () => {
			events.push('second error');
		},
	});

	await expect.poll(() => events).toEqual(['second done']);

	if (!first.resolve) {
		throw new Error('First waiter did not start');
	}

	first.resolve('first');
	await Promise.resolve();

	expect(events).toEqual(['second done']);
});

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

test('a failed decode frees the slot for the next decode', async () => {
	const events: string[] = [];
	waitForTurn({
		getPriority: () => 0,
		fn: () => Promise.reject(new Error('decode failed')),
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
});

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

test('includes work enqueued by stale cleanup when choosing the next deadline', async () => {
	const events: string[] = [];
	let armed = false;
	waitForTurn({
		getPriority: () => (armed ? null : 3),
		fn: () => Promise.resolve(),
		onDone: () => {
			events.push('stale');
		},
		onError: () => {
			waitForTurn({
				getPriority: () => 0,
				fn: () => Promise.resolve(),
				onDone: () => {
					events.push('urgent');
				},
				onError: (error) => {
					throw error;
				},
			});
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
	armed = true;
	processNext();
	await expect.poll(() => events).toEqual(['urgent', 'regular']);
});

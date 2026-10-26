import {Effect, PubSub} from 'effect';

type Waiter = {
	getPriority: () => number | null;
	fn: () => Promise<unknown>;
	onDone: (result: unknown) => void;
	onError: (error: unknown) => void;
};

export class StaleWaiterError extends Error {
	constructor() {
		super('Waiter became stale before it got its turn');
		this.name = 'StaleWaiterError';
	}
}

const waiters: Waiter[] = [];
let wake: (() => void) | null = null;

const drain = Effect.scoped(
	Effect.gen(function* () {
		const changes = yield* Effect.acquireRelease(
			PubSub.unbounded<{error: unknown} | null>(),
			PubSub.shutdown,
		);
		const take = PubSub.take(yield* PubSub.subscribe(changes));
		const notify = () => PubSub.publishUnsafe(changes, null);
		let running: Waiter | null = null;
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				wake = null;
				running = null;
			}),
		);
		// Ready jobs stay native; PubSub owns control changes and fatal errors.
		const pump = () => {
			if (running !== null && running.getPriority() !== null) {
				return;
			}

			running = null;
			while (waiters.length > 0) {
				const stale: Waiter[] = [];
				let selected = -1;
				let priority = 0;
				for (let index = 0; index < waiters.length; index++) {
					const waiter = waiters[index];
					const candidate = waiter.getPriority();
					if (candidate === null) {
						stale.push(waiter);
					} else if (selected === -1 || candidate < priority) {
						selected = index;
						priority = candidate;
					}
				}

				if (stale.length > 0 || selected === -1) {
					for (const waiter of stale) {
						waiters.splice(waiters.indexOf(waiter), 1);
					}

					for (const waiter of stale) {
						waiter.onError(new StaleWaiterError());
					}

					continue;
				}

				if (priority > 2) {
					return;
				}

				const next = waiters[selected];
				waiters.splice(selected, 1);
				running = next;
				const finish = (deliver: () => void) => {
					try {
						if (running !== next) {
							return;
						}

						if (next.getPriority() !== null) {
							deliver();
						}

						running = null;
						pump();
					} catch (error) {
						PubSub.publishUnsafe(changes, {error});
					}
				};

				let task: Promise<unknown>;
				try {
					task = next.fn();
				} catch (error) {
					task = Promise.reject(error);
				}

				task.then(
					(value) => finish(() => next.onDone(value)),
					(error) => finish(() => next.onError(error)),
				);
				return;
			}

			notify();
		};

		wake = () => {
			if (running === null || running.getPriority() === null) {
				// Reentrant admissions must wait until their callback finishes.
				queueMicrotask(notify);
			}
		};

		pump();
		while (true) {
			const change = yield* take;
			// Cleanup failures must survive even if they removed the last waiter.
			if (change !== null) {
				yield* Effect.die(change.error);
			}

			if (waiters.length === 0 && running === null) {
				return;
			}

			pump();
		}
	}),
);

export const processNext = (): void => {
	if (wake !== null) {
		wake();
	} else if (waiters.length > 0) {
		Effect.runPromise(drain);
	}
};

export const waitForTurn = <T>({
	getPriority,
	fn,
	onDone,
	onError,
}: {
	getPriority: () => number | null;
	fn: () => Promise<T>;
	onDone: (value: T) => void;
	onError: (error: unknown) => void;
}): void => {
	waiters.push({
		getPriority,
		fn,
		onDone: onDone as (value: unknown) => void,
		onError,
	});
	processNext();
};

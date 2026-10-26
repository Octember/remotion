import {Effect, PubSub} from 'effect';

type Waiter = {
	getPriority: () => number | null;
	fn: () => Promise<unknown>;
	onDone: (result: unknown) => void;
	onError: (err: unknown) => void;
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
			PubSub.unbounded<{waiter: Waiter; deliver: () => void} | null>(),
			PubSub.shutdown,
		);
		const nextChange = PubSub.take(yield* PubSub.subscribe(changes));
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				wake = null;
			}),
		);
		let running: Waiter | null = null;
		wake = () => {
			if (running === null || running.getPriority() === null) {
				PubSub.publishUnsafe(changes, null);
			}
		};

		while (waiters.length > 0 || running) {
			if (running && running.getPriority() !== null) {
				const completion = yield* nextChange;
				if (completion?.waiter !== running) {
					continue;
				}

				if (running.getPriority() !== null) {
					completion.deliver();
				}
			}

			running = null;
			const stale: Waiter[] = [];
			let selected: Waiter | null = null;
			let priority = 0;
			for (const waiter of waiters) {
				const candidate = waiter.getPriority();
				if (candidate === null) {
					stale.push(waiter);
				} else if (selected === null || candidate < priority) {
					selected = waiter;
					priority = candidate;
				}
			}

			if (stale.length > 0 || selected === null) {
				for (const waiter of stale) {
					waiters.splice(waiters.indexOf(waiter), 1);
				}

				for (const waiter of stale) {
					waiter.onError(new StaleWaiterError());
				}

				continue;
			}

			if (priority > 2) {
				yield* nextChange;
				continue;
			}

			const next = selected;
			waiters.splice(waiters.indexOf(next), 1);
			running = next;
			new Promise<unknown>((resolve) => resolve(next.fn())).then(
				(value) =>
					PubSub.publishUnsafe(changes, {
						waiter: next,
						deliver: () => next.onDone(value),
					}),
				(error) =>
					PubSub.publishUnsafe(changes, {
						waiter: next,
						deliver: () => next.onError(error),
					}),
			);
		}
	}),
);

export const processNext = (): void => {
	if (wake) {
		wake();
		return;
	}

	if (waiters.length > 0) {
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
	onDone: (result: T) => void;
	onError: (err: unknown) => void;
}): void => {
	waiters.push({
		getPriority,
		fn,
		onDone: onDone as (result: unknown) => void,
		onError,
	});
	processNext();
};

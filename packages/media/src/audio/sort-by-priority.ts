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
			PubSub.sliding<void>(1),
			PubSub.shutdown,
		);
		const subscription = yield* PubSub.subscribe(changes);
		yield* Effect.acquireRelease(
			Effect.sync(() => {
				wake = () => {
					PubSub.publishUnsafe(changes, undefined);
				};
			}),
			() =>
				Effect.sync(() => {
					wake = null;
				}),
		);

		while (waiters.length > 0) {
			const stale = waiters.filter((waiter) => waiter.getPriority() === null);
			for (const waiter of stale) {
				waiters.splice(waiters.indexOf(waiter), 1);
			}

			for (const waiter of stale) {
				waiter.onError(new StaleWaiterError());
			}

			let selected: Waiter | null = null;
			let priority = 0;
			for (const waiter of waiters) {
				const candidate = waiter.getPriority();
				if (candidate !== null && (selected === null || candidate < priority)) {
					selected = waiter;
					priority = candidate;
				}
			}

			if (selected === null) {
				continue;
			}

			if (priority > 2) {
				yield* PubSub.take(subscription);
				continue;
			}

			const next = selected;
			waiters.splice(waiters.indexOf(next), 1);
			yield* Effect.raceFirst(
				Effect.tryPromise({
					try: next.fn,
					catch: (error) => error,
				}).pipe(
					Effect.match({
						onSuccess: (value) => {
							if (next.getPriority() !== null) {
								next.onDone(value);
							}
						},
						onFailure: (error) => {
							if (next.getPriority() !== null) {
								next.onError(error);
							}
						},
					}),
				),
				Effect.gen(function* () {
					while (next.getPriority() !== null) {
						yield* PubSub.take(subscription);
					}
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

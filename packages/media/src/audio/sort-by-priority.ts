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
			const priorities = waiters.map((waiter) => ({
				waiter,
				priority: waiter.getPriority(),
			}));
			const stale = priorities.filter((entry) => entry.priority === null);
			for (const entry of stale) {
				waiters.splice(waiters.indexOf(entry.waiter), 1);
			}

			for (const entry of stale) {
				entry.waiter.onError(new StaleWaiterError());
			}

			const next = priorities
				.filter(
					(entry): entry is {waiter: Waiter; priority: number} =>
						entry.priority !== null,
				)
				.sort((a, b) => a.priority - b.priority)[0];
			if (!next) {
				continue;
			}

			if (next.priority > 2) {
				yield* PubSub.take(subscription);
				continue;
			}

			waiters.splice(waiters.indexOf(next.waiter), 1);
			yield* Effect.raceFirst(
				Effect.tryPromise({
					try: next.waiter.fn,
					catch: (error) => error,
				}).pipe(
					Effect.match({
						onSuccess: (value) => {
							if (next.waiter.getPriority() !== null) {
								next.waiter.onDone(value);
							}
						},
						onFailure: (error) => {
							if (next.waiter.getPriority() !== null) {
								next.waiter.onError(error);
							}
						},
					}),
				),
				Effect.gen(function* () {
					while (next.waiter.getPriority() !== null) {
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

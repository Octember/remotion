import {Effect, PubSub, Semaphore} from 'effect';

export class StaleWaiterError extends Error {
	constructor() {
		super('Waiter became stale before it got its turn');
		this.name = 'StaleWaiterError';
	}
}

const makeAudioScheduler = () => {
	const changes = Effect.runSync(PubSub.sliding<void>(1));
	const decoder = Semaphore.makeUnsafe(1);
	// Deadlines change during playback; fibers own the work, not this registry.
	const pending = new Set<() => number | null>();
	const notify = () => Effect.runSync(PubSub.publish(changes, undefined));

	return {
		notify,
		run: <T, E>(
			getPriority: () => number | null,
			decode: Effect.Effect<T, E>,
		) =>
			Effect.scoped(
				Effect.gen(function* () {
					const subscription = yield* PubSub.subscribe(changes);
					const priority = yield* Effect.acquireRelease(
						Effect.sync(() => {
							const entry = () => getPriority();
							pending.add(entry);
							notify();
							return entry;
						}),
						(entry) =>
							Effect.sync(() => {
								pending.delete(entry);
								notify();
							}),
					);
					return yield* Effect.raceFirst(
						Effect.gen(function* () {
							while (true) {
								const result = yield* decoder.withPermit(
									Effect.gen(function* () {
										let first: (() => number | null) | null = null;
										let earliest = Infinity;
										for (const entry of pending) {
											const deadline = entry();
											if (
												deadline !== null &&
												deadline <= 2 &&
												deadline < earliest
											) {
												first = entry;
												earliest = deadline;
											}
										}

										if (first !== priority) return null;
										return {value: yield* decode};
									}),
								);
								if (result) return result.value;
								yield* PubSub.take(subscription);
							}
						}),
						Effect.gen(function* () {
							const stale = yield* PubSub.subscribe(changes);
							while (priority() !== null) yield* PubSub.take(stale);
							return yield* Effect.fail(new StaleWaiterError());
						}),
					);
				}),
			),
	};
};

const schedulers = new WeakMap<
	AudioContext,
	ReturnType<typeof makeAudioScheduler>
>();

export const getAudioScheduler = (context: AudioContext) => {
	let scheduler = schedulers.get(context);
	if (!scheduler) {
		scheduler = makeAudioScheduler();
		schedulers.set(context, scheduler);
	}

	return scheduler;
};

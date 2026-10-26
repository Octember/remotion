import {Deferred, Effect, Exit, Fiber, PubSub, Scope} from 'effect';

export class StaleAudioRequestError extends Error {
	constructor() {
		super('Audio request became stale before it got its turn');
		this.name = 'StaleAudioRequestError';
	}
}

type Request = {
	getPriority: () => number | null;
	ready: Deferred.Deferred<void, StaleAudioRequestError>;
	fiber: Fiber.Fiber<unknown, unknown>;
};

export const createAudioScheduler = () => {
	const scope = Scope.makeUnsafe();
	const changes = Effect.runSync(PubSub.unbounded<void>());
	const pending = new Set<Request>();
	let active: Request | null = null;
	const wake = () => {
		PubSub.publishUnsafe(changes, undefined);
	};

	Effect.runSync(
		Scope.addFinalizer(
			scope,
			Effect.gen(function* () {
				for (const request of [...pending, ...(active ? [active] : [])]) {
					yield* Fiber.interrupt(request.fiber);
				}

				yield* PubSub.shutdown(changes);
			}),
		),
	);

	Effect.runSync(
		Effect.gen(function* () {
			const events = yield* PubSub.subscribe(changes);
			yield* Effect.forkIn(
				Effect.gen(function* () {
					while (true) {
						yield* PubSub.take(events);
						if (active?.getPriority() === null) {
							yield* Fiber.interrupt(active.fiber);
						}

						let next: Request | null = null;
						let earliest = Infinity;
						for (const request of pending) {
							const priority = request.getPriority();
							if (priority === null) {
								pending.delete(request);
								yield* Deferred.fail(
									request.ready,
									new StaleAudioRequestError(),
								);
							} else if (priority <= 2 && priority < earliest) {
								next = request;
								earliest = priority;
							}
						}

						if (!active && next) {
							pending.delete(next);
							active = next;
							yield* Deferred.succeed(next.ready, undefined);
						}
					}
				}),
				scope,
			);
		}).pipe(Scope.provide(scope)),
	);

	const run = <A, E>(
		getPriority: () => number | null,
		task: Effect.Effect<A, E>,
	) =>
		Effect.suspend(() =>
			scope.state._tag === 'Closed'
				? Effect.interrupt
				: Effect.acquireUseRelease(
						Effect.gen(function* () {
							const request: Request = {
								getPriority,
								ready: yield* Deferred.make<void, StaleAudioRequestError>(),
								fiber: yield* Effect.fiber,
							};
							pending.add(request);
							wake();
							return request;
						}),
						(request) =>
							Deferred.await(request.ready).pipe(Effect.andThen(task)),
						(request) =>
							Effect.sync(() => {
								pending.delete(request);
								if (active === request) {
									active = null;
								}

								wake();
							}),
					),
		);

	return {
		run,
		wake,
		close: () => Effect.runFork(Scope.close(scope, Exit.void)),
	};
};

type AudioScheduler = ReturnType<typeof createAudioScheduler>;
const schedulers = new WeakMap<
	AudioContext,
	{scheduler: AudioScheduler; users: number}
>();

export const acquireAudioScheduler = (audioContext: AudioContext) => {
	let entry = schedulers.get(audioContext);
	if (!entry) {
		entry = {scheduler: createAudioScheduler(), users: 0};
		schedulers.set(audioContext, entry);
	}

	entry.users++;
	const acquired = entry;
	const lease = Scope.makeUnsafe();
	Effect.runSync(
		Scope.addFinalizer(
			lease,
			Effect.sync(() => {
				acquired.users--;
				if (acquired.users === 0) {
					schedulers.delete(audioContext);
					acquired.scheduler.close();
				}
			}),
		),
	);
	return {
		run: acquired.scheduler.run,
		wake: acquired.scheduler.wake,
		release: () => Effect.runFork(Scope.close(lease, Exit.void)),
	};
};

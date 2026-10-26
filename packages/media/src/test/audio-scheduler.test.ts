import {Deferred, Effect, Exit, Fiber} from 'effect';
import {afterEach, expect, test} from 'vitest';
import {
	acquireAudioScheduler,
	createAudioScheduler,
} from '../audio/audio-scheduler';

const schedulers: ReturnType<typeof createAudioScheduler>[] = [];
const create = () => {
	const scheduler = createAudioScheduler();
	schedulers.push(scheduler);
	return scheduler;
};

afterEach(async () => {
	for (const scheduler of schedulers.splice(0)) {
		await Effect.runPromise(Fiber.join(scheduler.close()));
	}
});

test('serializes decoding by nearest deadline and parks work beyond two seconds', async () => {
	const scheduler = create();
	const gate = Deferred.makeUnsafe<void>();
	const started = Deferred.makeUnsafe<void>();
	const events: string[] = [];
	const blocker = Effect.runFork(
		scheduler.run(
			() => 0,
			Effect.gen(function* () {
				yield* Deferred.succeed(started, undefined);
				yield* Deferred.await(gate);
			}),
		),
	);
	await Effect.runPromise(Deferred.await(started));
	let horizon = 3;
	const parked = Effect.runFork(
		scheduler.run(
			() => horizon,
			Effect.sync(() => {
				events.push('parked');
			}),
		),
	);
	const later = Effect.runFork(
		scheduler.run(
			() => 1,
			Effect.sync(() => {
				events.push('later');
			}),
		),
	);
	const earlier = Effect.runFork(
		scheduler.run(
			() => -1,
			Effect.sync(() => {
				events.push('earlier');
			}),
		),
	);
	Effect.runSync(Deferred.succeed(gate, undefined));
	await Effect.runPromise(Fiber.joinAll([blocker, later, earlier]));
	expect(events).toEqual(['earlier', 'later']);
	horizon = 2;
	scheduler.wake();
	await Effect.runPromise(Fiber.join(parked));
	expect(events).toEqual(['earlier', 'later', 'parked']);
});

test('interrupts stale decoding without observing its late completion', async () => {
	const scheduler = create();
	const events: string[] = [];
	let priority: number | null = 0;
	let resolve: (value: string) => void = () => {
		throw new Error('Decoder has not started');
	};

	const started = Deferred.makeUnsafe<void>();
	const first = Effect.runFork(
		scheduler.run(
			() => priority,
			Effect.gen(function* () {
				yield* Deferred.succeed(started, undefined);
				yield* Effect.promise(
					() =>
						new Promise<string>((done) => {
							resolve = done;
						}),
				);
				events.push('stale completion');
			}),
		),
	);
	await Effect.runPromise(Deferred.await(started));
	priority = null;
	const second = Effect.runFork(
		scheduler.run(
			() => 0,
			Effect.sync(() => {
				events.push('fresh');
			}),
		),
	);
	await Effect.runPromise(Fiber.join(second));
	resolve('late');
	expect(Exit.isFailure(await Effect.runPromiseExit(Fiber.join(first)))).toBe(
		true,
	);
	expect(events).toEqual(['fresh']);
});

test('a failed decode releases its slot for another request', async () => {
	const scheduler = create();
	const failure = new Error('Invalid audio data');
	const failed = Effect.runFork(scheduler.run(() => 0, Effect.fail(failure)));
	const recovery = Effect.runFork(
		scheduler.run(() => 0, Effect.succeed('recovered')),
	);
	expect(await Effect.runPromise(Fiber.join(recovery))).toBe('recovered');
	expect(await Effect.runPromiseExit(Fiber.join(failed))).toEqual(
		Exit.fail(failure),
	);
});

test('a native scheduling defect retains its failure and releases the next request', async () => {
	const scheduler = create();
	const defect = new Error('AudioContext rejected the buffer source');
	const failed = Effect.runFork(
		scheduler.run(
			() => 0,
			Effect.sync(() => {
				throw defect;
			}),
		),
	);
	const recovery = Effect.runFork(
		scheduler.run(() => 0, Effect.succeed('recovered')),
	);
	expect(await Effect.runPromise(Fiber.join(recovery))).toBe('recovered');
	expect(await Effect.runPromiseExit(Fiber.join(failed))).toEqual(
		Exit.die(defect),
	);
});

test('closing interrupts both active and parked requests and rejects new work', async () => {
	const scheduler = create();
	const started = Deferred.makeUnsafe<void>();
	const active = Effect.runFork(
		scheduler.run(
			() => 0,
			Effect.gen(function* () {
				yield* Deferred.succeed(started, undefined);
				yield* Effect.never;
			}),
		),
	);
	await Effect.runPromise(Deferred.await(started));
	const parked = Effect.runFork(scheduler.run(() => 3, Effect.void));
	await Effect.runPromise(Fiber.join(scheduler.close()));
	expect(Exit.isFailure(await Effect.runPromiseExit(Fiber.join(active)))).toBe(
		true,
	);
	expect(Exit.isFailure(await Effect.runPromiseExit(Fiber.join(parked)))).toBe(
		true,
	);
	expect(
		Exit.isFailure(
			await Effect.runPromiseExit(scheduler.run(() => 0, Effect.void)),
		),
	).toBe(true);
});

test('shares one owner per AudioContext and releases the last lease exactly once', async () => {
	const context = new AudioContext();
	const otherContext = new AudioContext();
	const first = acquireAudioScheduler(context);
	const second = acquireAudioScheduler(context);
	const other = acquireAudioScheduler(otherContext);
	expect(first.run).toBe(second.run);
	expect(first.run).not.toBe(other.run);
	const active = Effect.runFork(first.run(() => 0, Effect.never));
	expect(
		await Effect.runPromise(other.run(() => 0, Effect.succeed('independent'))),
	).toBe('independent');
	first.release();
	first.release();
	second.wake();
	expect(active.pollUnsafe()).toBeUndefined();
	second.release();
	expect(Exit.isFailure(await Effect.runPromiseExit(Fiber.join(active)))).toBe(
		true,
	);
	const replacement = acquireAudioScheduler(context);
	expect(replacement.run).not.toBe(first.run);
	replacement.release();
	other.release();
	await context.close();
	await otherContext.close();
});

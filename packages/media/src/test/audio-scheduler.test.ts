import {Effect} from 'effect';
import {afterAll, expect, test} from 'vitest';
import {getAudioScheduler, StaleWaiterError} from '../audio/audio-scheduler';

const context = new AudioContext();
const scheduler = getAudioScheduler(context);
afterAll(() => context.close());

test('failure and defects release the decode permit', async () => {
	for (const decode of [Effect.fail('failed'), Effect.die('defect')]) {
		await Effect.runPromise(Effect.exit(scheduler.run(() => 0, decode)));
		expect(
			await Effect.runPromise(scheduler.run(() => 0, Effect.succeed('next'))),
		).toBe('next');
	}
});

test('interruption removes a pending priority and releases a running permit', async () => {
	for (const priority of [0, 3]) {
		const fiber = Effect.runFork(scheduler.run(() => priority, Effect.never));
		fiber.interruptUnsafe();
		expect(
			await Effect.runPromise(scheduler.run(() => 1, Effect.succeed('next'))),
		).toBe('next');
	}
});

test('one audio context cannot block another context', async () => {
	const otherContext = new AudioContext();
	const fiber = Effect.runFork(scheduler.run(() => 0, Effect.never));
	try {
		expect(
			await Effect.runPromise(
				getAudioScheduler(otherContext).run(
					() => 0,
					Effect.succeed('independent'),
				),
			),
		).toBe('independent');
	} finally {
		fiber.interruptUnsafe();
		await otherContext.close();
	}
});

test('stale decode is interrupted and its late result is never delivered', async () => {
	let priority: number | null = 0;
	const events: string[] = [];
	const first = {resolve: null as (() => void) | null};
	const result = Effect.runPromise(
		scheduler
			.run(
				() => priority,
				Effect.promise(
					() =>
						new Promise<void>((resolve) => {
							first.resolve = resolve;
						}),
				),
			)
			.pipe(
				Effect.match({
					onSuccess: () => events.push('unexpected'),
					onFailure: (error) => {
						expect(error).toBeInstanceOf(StaleWaiterError);
						events.push('stale');
					},
				}),
			),
	);
	await expect.poll(() => first.resolve).not.toBeNull();
	priority = null;
	scheduler.notify();
	await result;
	expect(
		await Effect.runPromise(scheduler.run(() => 0, Effect.succeed('next'))),
	).toBe('next');
	first.resolve?.();
	await Promise.resolve();
	expect(events).toEqual(['stale']);
});

test('rechecks dynamic priority after the running decode releases its permit', async () => {
	const first = {resolve: null as (() => void) | null};
	const running = Effect.runPromise(
		scheduler.run(
			() => -1,
			Effect.promise(
				() =>
					new Promise<void>((resolve) => {
						first.resolve = resolve;
					}),
			),
		),
	);
	await expect.poll(() => first.resolve).not.toBeNull();
	const events: string[] = [];
	let priority = 1;
	const later = Effect.runPromise(
		scheduler.run(
			() => priority,
			Effect.sync(() => {
				events.push('later');
			}),
		),
	);
	const earlier = Effect.runPromise(
		scheduler.run(
			() => 0,
			Effect.sync(() => {
				events.push('earlier');
			}),
		),
	);
	priority = 2;
	first.resolve?.();
	await Promise.all([running, later, earlier]);
	expect(events).toEqual(['earlier', 'later']);
});

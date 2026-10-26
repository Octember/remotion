import {afterEach, expect, test} from 'bun:test';
import {Effect, Fiber} from 'effect';
import {TestClock} from 'effect/testing';
import {playbackClock} from '../playback-clock.js';

afterEach(() => {
	Object.defineProperty(document, 'hidden', {configurable: true, value: false});
});

const fixture = () => {
	let frame = 0;
	let playing = true;
	let buffering = false;
	let ended = 0;
	const listeners = new Set<(state: {buffering: boolean}) => void>();
	const options = {
		fps: 10,
		firstFrame: 0,
		lastFrame: 100,
		playbackRate: 1,
		loop: false,
		moveToBeginningWhenEnded: false,
		muted: true,
		audio: null,
		getCurrentFrame: () => frame,
		isPlaying: () => playing,
		isBuffering: () => buffering,
		subscribeBuffering: (callback: (state: {buffering: boolean}) => void) => {
			listeners.add(callback);
			return () => {
				listeners.delete(callback);
			};
		},
		setFrame: (next: number) => {
			frame = next;
		},
		setMuted: () => undefined,
		onEnded: () => {
			ended++;
			playing = false;
		},
	};
	return {
		options,
		listeners,
		getEnded: () => ended,
		buffer: (value: boolean) => {
			buffering = value;
			for (const listener of listeners) {
				listener({buffering});
			}
		},
	};
};

test('the scoped clock excludes buffering time and releases its subscription', async () => {
	Object.defineProperty(document, 'hidden', {configurable: true, value: true});
	const f = fixture();
	await Effect.runPromise(
		Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(playbackClock(f.options));
			yield* TestClock.adjust(500);
			expect(f.options.getCurrentFrame()).toBe(5);
			f.buffer(true);
			yield* TestClock.adjust(5000);
			expect(f.options.getCurrentFrame()).toBe(5);
			f.buffer(false);
			yield* TestClock.adjust(200);
			expect(f.options.getCurrentFrame()).toBe(7);
			yield* Fiber.interrupt(fiber);
			expect(f.listeners.size).toBe(0);
			yield* TestClock.adjust(1000);
			expect(f.options.getCurrentFrame()).toBe(7);
		}).pipe(Effect.provide(TestClock.layer())),
	);
});

test('reverse playback loops at the configured bounds', async () => {
	Object.defineProperty(document, 'hidden', {configurable: true, value: true});
	const f = fixture();
	f.options.setFrame(3);
	f.options.playbackRate = -1;
	f.options.loop = true;
	f.options.firstFrame = 2;
	f.options.lastFrame = 4;
	await Effect.runPromise(
		Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(playbackClock(f.options));
			yield* TestClock.adjust(300);
			expect(f.options.getCurrentFrame()).toBe(3);
			expect(f.getEnded()).toBe(0);
			yield* Fiber.interrupt(fiber);
		}).pipe(Effect.provide(TestClock.layer())),
	);
});

test('completion is emitted once and preserves the last frame', async () => {
	Object.defineProperty(document, 'hidden', {configurable: true, value: true});
	const f = fixture();
	f.options.lastFrame = 2;
	await Effect.runPromise(
		Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(playbackClock(f.options));
			yield* TestClock.adjust(1000);
			yield* Fiber.join(fiber);
			expect(f.options.getCurrentFrame()).toBe(2);
			expect(f.getEnded()).toBe(1);
			expect(f.listeners.size).toBe(0);
		}).pipe(Effect.provide(TestClock.layer())),
	);
});

test('visibility and buffering changes cancel the pending paint without a jump', async () => {
	const request = globalThis.requestAnimationFrame;
	const cancel = globalThis.cancelAnimationFrame;
	const frames = new Map<number, FrameRequestCallback>();
	let id = 0;
	globalThis.requestAnimationFrame = (callback) => {
		id++;
		frames.set(id, callback);
		return id;
	};

	globalThis.cancelAnimationFrame = (frameId) => {
		frames.delete(frameId);
	};

	const f = fixture();
	try {
		await Effect.runPromise(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(playbackClock(f.options));
				yield* TestClock.adjust(500);
				expect(frames.size).toBe(1);
				Object.defineProperty(document, 'hidden', {
					configurable: true,
					value: true,
				});
				document.dispatchEvent(new Event('visibilitychange'));
				yield* TestClock.adjust(100);
				expect(frames.size).toBe(0);
				expect(f.options.getCurrentFrame()).toBe(6);
				Object.defineProperty(document, 'hidden', {
					configurable: true,
					value: false,
				});
				document.dispatchEvent(new Event('visibilitychange'));
				yield* TestClock.adjust(0);
				expect(frames.size).toBe(1);
				f.buffer(true);
				yield* TestClock.adjust(1000);
				expect(frames.size).toBe(0);
				expect(f.options.getCurrentFrame()).toBe(6);
				f.buffer(false);
				yield* TestClock.adjust(0);
				expect(frames.size).toBe(1);
				yield* Fiber.interrupt(fiber);
				expect(frames.size).toBe(0);
				expect(f.listeners.size).toBe(0);
			}).pipe(Effect.provide(TestClock.layer())),
		);
	} finally {
		globalThis.requestAnimationFrame = request;
		globalThis.cancelAnimationFrame = cancel;
	}
});

test('interrupting a buffering clock releases its subscription before it can resume', async () => {
	Object.defineProperty(document, 'hidden', {configurable: true, value: true});
	const f = fixture();
	f.buffer(true);
	await Effect.runPromise(
		Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(playbackClock(f.options));
			yield* TestClock.adjust(1000);
			expect(f.listeners.size).toBe(1);
			yield* Fiber.interrupt(fiber);
			f.buffer(false);
			yield* TestClock.adjust(1000);
			expect(f.listeners.size).toBe(0);
			expect(f.options.getCurrentFrame()).toBe(0);
		}).pipe(Effect.provide(TestClock.layer())),
	);
});

test.each([
	{
		rate: 2,
		start: 0,
		first: 0,
		last: 100,
		loop: false,
		rewind: false,
		elapsed: 500,
		expected: 10,
		ended: 0,
	},
	{
		rate: 0.5,
		start: 0,
		first: 0,
		last: 100,
		loop: false,
		rewind: false,
		elapsed: 1000,
		expected: 5,
		ended: 0,
	},
	{
		rate: 1,
		start: 3,
		first: 2,
		last: 4,
		loop: true,
		rewind: false,
		elapsed: 300,
		expected: 3,
		ended: 0,
	},
	{
		rate: 1,
		start: 2,
		first: 2,
		last: 4,
		loop: false,
		rewind: true,
		elapsed: 500,
		expected: 2,
		ended: 1,
	},
])('preserves frame bounds and playback rate: %j', async (scenario) => {
	Object.defineProperty(document, 'hidden', {configurable: true, value: true});
	const f = fixture();
	f.options.setFrame(scenario.start);
	f.options.playbackRate = scenario.rate;
	f.options.firstFrame = scenario.first;
	f.options.lastFrame = scenario.last;
	f.options.loop = scenario.loop;
	f.options.moveToBeginningWhenEnded = scenario.rewind;
	await Effect.runPromise(
		Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(playbackClock(f.options));
			yield* TestClock.adjust(scenario.elapsed);
			expect(f.options.getCurrentFrame()).toBe(scenario.expected);
			expect(f.getEnded()).toBe(scenario.ended);
			yield* Fiber.interrupt(fiber);
		}).pipe(Effect.provide(TestClock.layer())),
	);
});

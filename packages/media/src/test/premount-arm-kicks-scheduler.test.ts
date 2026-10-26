import {Effect, Fiber} from 'effect';
import type {useBufferState} from 'remotion';
import {expect, test} from 'vitest';
import {acquireAudioScheduler} from '../audio/audio-scheduler';
import {MediaPlayer} from '../media-player';

const makePlayer = async ({
	isPremounting,
	isPostmounting,
}: {
	isPremounting: boolean;
	isPostmounting: boolean;
}) => {
	const audioContext = new AudioContext();
	const player = new MediaPlayer({
		canvas: null,
		src: '/junk.wav',
		logLevel: 'info',
		sharedAudioContext: {
			audioContext,
			gainNode: audioContext.createGain(),
			audioSyncAnchor: {value: 0},
			scheduleAudioNode: () => ({type: 'not-started', reason: 'muted'}),
			unscheduleAudioNode: () => {},
		},
		loop: false,
		trimBefore: undefined,
		trimAfter: undefined,
		playbackRate: 1,
		toneFrequency: 1,
		globalPlaybackRate: 1,
		audioStreamIndex: 0,
		fps: 30,
		debugOverlay: false,
		bufferState: {
			delayPlayback: () => ({unblock: () => undefined}),
		} as unknown as ReturnType<typeof useBufferState>,
		isPremounting,
		isPostmounting,
		durationInFrames: 100,
		onVideoFrameCallback: null,
		playing: false,
		sequenceOffset: 0,
		credentials: undefined,
		requestInit: undefined,
		tagType: 'audio',
		getEffects: () => [],
		getEffectChainState: () => null,
	});
	expect((await player.initialize(0, true, 1)).type).toBe('success');
	const scheduler = acquireAudioScheduler(audioContext);
	return {
		player,
		scheduler,
		dispose: async () => {
			await player.dispose();
			scheduler.release();
			await audioContext.close();
		},
	};
};

const sleep = (ms: number) =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});

const parkWaiter = (scheduler: ReturnType<typeof acquireAudioScheduler>) => {
	const events: string[] = [];
	let priority: number | null = 3;

	const fiber = Effect.runFork(
		scheduler
			.run(
				() => priority,
				Effect.sync(() => {
					events.push('done');
				}),
			)
			.pipe(
				Effect.catch((error) =>
					Effect.sync(() => {
						events.push(error.name);
					}),
				),
			),
	);

	return {
		events,
		fiber,
		setPriority: (newPriority: number | null) => {
			priority = newPriority;
		},
	};
};

test('ending premounting gives deferred audio waiters a turn', async () => {
	const {player, scheduler, dispose} = await makePlayer({
		isPremounting: true,
		isPostmounting: false,
	});
	const {events, setPriority, fiber} = parkWaiter(scheduler);
	await sleep(50);

	setPriority(1);
	await sleep(50);
	expect(events).toEqual([]);

	player.setIsPremounting(false);
	await Effect.runPromise(Fiber.join(fiber));
	expect(events).toEqual(['done']);
	await dispose();
});

test('ending postmounting gives deferred audio waiters a turn', async () => {
	const {player, scheduler, dispose} = await makePlayer({
		isPremounting: false,
		isPostmounting: true,
	});
	const {events, setPriority, fiber} = parkWaiter(scheduler);
	await sleep(50);

	setPriority(1);
	await sleep(50);
	expect(events).toEqual([]);

	player.setIsPostmounting(false);
	await Effect.runPromise(Fiber.join(fiber));
	expect(events).toEqual(['done']);
	await dispose();
});

test('the kick keeps deferring waiters beyond the horizon and sweeps stale ones', async () => {
	const {player, scheduler, dispose} = await makePlayer({
		isPremounting: true,
		isPostmounting: false,
	});
	const {events, setPriority, fiber} = parkWaiter(scheduler);

	player.setIsPremounting(false);
	await sleep(50);
	expect(events).toEqual([]);

	setPriority(null);
	player.setIsPremounting(true);
	await Effect.runPromise(Fiber.join(fiber));
	expect(events).toEqual(['StaleAudioRequestError']);
	await dispose();
});

import {Effect} from 'effect';
import type {useBufferState} from 'remotion';
import {afterAll, expect, test} from 'vitest';
import {getAudioScheduler} from '../audio/audio-scheduler';
import {MediaPlayer} from '../media-player';

const context = new AudioContext();
const scheduler = getAudioScheduler(context);
afterAll(() => context.close());

const makePlayer = ({
	isPremounting,
	isPostmounting,
}: {
	isPremounting: boolean;
	isPostmounting: boolean;
}) => {
	return new MediaPlayer({
		canvas: null,
		src: '/bigbuckbunny.mp4',
		logLevel: 'info',
		sharedAudioContext: {
			audioContext: context,
			gainNode: context.createGain(),
			audioSyncAnchor: {value: 0},
			scheduleAudioNode: () => ({
				type: 'not-started',
				reason: 'No media loaded',
			}),
			unscheduleAudioNode: () => undefined,
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
};

const sleep = (ms: number) =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});

const parkWaiter = async () => {
	const events: string[] = [];
	let priority: number | null = 3;
	let evaluated = false;

	Effect.runFork(
		scheduler
			.run(() => {
				evaluated = true;
				return priority;
			}, Effect.succeed('deferred'))
			.pipe(
				Effect.match({
					onSuccess: () => {
						events.push('done');
					},
					onFailure: (err) => {
						events.push((err as Error).name);
					},
				}),
			),
	);

	await expect.poll(() => evaluated).toBe(true);
	return {
		events,
		setPriority: (newPriority: number | null) => {
			priority = newPriority;
		},
	};
};

test('ending premounting gives deferred audio waiters a turn', async () => {
	const {events, setPriority} = await parkWaiter();
	const mediaPlayer = makePlayer({isPremounting: true, isPostmounting: false});

	setPriority(1);
	await sleep(50);
	expect(events).toEqual([]);

	mediaPlayer.setIsPremounting(false);
	await sleep(50);
	expect(events).toEqual(['done']);
});

test('ending postmounting gives deferred audio waiters a turn', async () => {
	const {events, setPriority} = await parkWaiter();
	const mediaPlayer = makePlayer({isPremounting: false, isPostmounting: true});

	setPriority(1);
	await sleep(50);
	expect(events).toEqual([]);

	mediaPlayer.setIsPostmounting(false);
	await sleep(50);
	expect(events).toEqual(['done']);
});

test('the kick keeps deferring waiters beyond the horizon and sweeps stale ones', async () => {
	const {events, setPriority} = await parkWaiter();
	const mediaPlayer = makePlayer({isPremounting: true, isPostmounting: false});

	mediaPlayer.setIsPremounting(false);
	await sleep(50);
	expect(events).toEqual([]);

	setPriority(null);
	mediaPlayer.setIsPremounting(true);
	await sleep(50);
	expect(events).toEqual(['StaleWaiterError']);
});

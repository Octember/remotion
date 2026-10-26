import {afterEach, beforeEach, expect, spyOn, test} from 'bun:test';
import {createRef} from 'react';
import {Html5Audio, Internals, useBufferState} from 'remotion';
import type {PlayerRef} from '../player-methods.js';
import {Player} from '../Player.js';
import {act, cleanup, render} from './test-utils.js';

const originalAudioContext = globalThis.AudioContext;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
const animationFrames = new Map<number, FrameRequestCallback>();
let animationFrameId = 0;
let resumeCalls = 0;
let resumeResult: 'resolved' | 'pending' | 'rejected' = 'resolved';
let context: ControlledAudioContext | null = null;
let now = 1000;
let restoreClock: () => void = () => undefined;
let delayPlayback: ReturnType<typeof useBufferState>['delayPlayback'] | null =
	null;

class ControlledAudioContext extends EventTarget {
	public state = 'suspended' as AudioContextState;
	public baseLatency = 0;
	public outputLatency = 0;
	public currentTime = 0;
	public destination = {};

	constructor() {
		super();
		context = this;
	}

	createGain() {
		return {
			connect: () => undefined,
			gain: {
				cancelScheduledValues: () => undefined,
				linearRampToValueAtTime: () => undefined,
				setValueAtTime: () => undefined,
			},
		};
	}

	suspend() {
		this.state = 'suspended';
		this.dispatchEvent(new Event('statechange'));
		return Promise.resolve();
	}

	resume() {
		resumeCalls++;
		if (resumeResult === 'pending') {
			return new Promise<void>(() => undefined);
		}

		if (resumeResult === 'rejected') {
			return Promise.reject(new Error('Autoplay blocked'));
		}

		return Promise.resolve();
	}

	becomeRunning() {
		this.state = 'running';
		this.dispatchEvent(new Event('statechange'));
	}

	getOutputTimestamp() {
		return {contextTime: 0, performanceTime: 0};
	}

	createMediaElementSource() {
		return {
			connect: () => undefined,
			disconnect: () => undefined,
		};
	}
}

beforeEach(() => {
	context = null;
	delayPlayback = null;
	resumeCalls = 0;
	resumeResult = 'resolved';
	now = 1000;
	animationFrameId = 0;
	animationFrames.clear();
	const performanceClock = spyOn(performance, 'now').mockImplementation(
		() => now,
	);
	const effectClock = spyOn(process.hrtime, 'bigint').mockImplementation(
		() => BigInt(now) * BigInt(1_000_000),
	);
	restoreClock = () => {
		performanceClock.mockRestore();
		effectClock.mockRestore();
	};

	globalThis.AudioContext =
		ControlledAudioContext as unknown as typeof AudioContext;
	globalThis.requestAnimationFrame = (callback) => {
		animationFrameId++;
		animationFrames.set(animationFrameId, callback);
		return animationFrameId;
	};

	globalThis.cancelAnimationFrame = (id) => {
		animationFrames.delete(id);
	};
});

afterEach(() => {
	cleanup();
	restoreClock();
	globalThis.AudioContext = originalAudioContext;
	globalThis.requestAnimationFrame = originalRequestAnimationFrame;
	globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
});

const sequenceManager = {
	registerSequence: () => undefined,
	unregisterSequence: () => undefined,
	updateSequence: null,
	sequences: [],
};

const AudioComposition = () => {
	delayPlayback = useBufferState().delayPlayback;

	return (
		<Internals.SequenceManager.Provider value={sequenceManager}>
			<Html5Audio src="audio.mp3" />
		</Internals.SequenceManager.Provider>
	);
};

const mountPlayer = () => {
	const playerRef = createRef<PlayerRef>();
	const {unmount} = render(
		<Player
			ref={playerRef}
			component={AudioComposition}
			durationInFrames={300}
			compositionWidth={1920}
			compositionHeight={1080}
			fps={30}
		/>,
	);
	const player = playerRef.current;
	const audioContext = context;
	if (!player || !audioContext) {
		throw new Error('Expected mounted Player and AudioContext');
	}

	return {
		player,
		audioContext,
		unmount,
		buffer: () => {
			if (!delayPlayback) {
				throw new Error('Expected buffering controls');
			}

			return delayPlayback();
		},
	};
};

const advance = async (milliseconds: number) => {
	now += milliseconds;
	const callbacks = [...animationFrames.values()];
	animationFrames.clear();
	await act(() => {
		for (const callback of callbacks) {
			callback(now);
		}
	});
};

test.each(['resolved', 'pending', 'rejected'] as const)(
	'Player waits for native running state when resume() is %s',
	async (result) => {
		resumeResult = result;
		const {player, audioContext} = mountPlayer();
		await act(() => player.play());
		expect(resumeCalls).toBe(1);
		expect(animationFrames.size).toBe(0);
		await advance(2000);
		expect(player.getCurrentFrame()).toBe(0);
		expect(player.isMuted()).toBe(false);

		if (result === 'rejected') {
			await act(() => player.pause());
			await act(() => player.play());
			expect(resumeCalls).toBe(2);
		}

		await act(() => audioContext.becomeRunning());
		expect(animationFrames.size).toBe(1);
		await advance(100);
		expect(player.getCurrentFrame()).toBe(3);
		expect(player.isPlaying()).toBe(true);
		expect(player.isMuted()).toBe(false);
	},
);

test('pending native resume does not time out into muted playback', async () => {
	resumeResult = 'pending';
	const {player} = mountPlayer();
	await act(() => player.play());
	await act(async () => {
		await new Promise<void>((resolve) => setTimeout(resolve, 1100));
	});
	expect(player.isPlaying()).toBe(true);
	expect(player.isMuted()).toBe(false);
	expect(player.getCurrentFrame()).toBe(0);
	expect(animationFrames.size).toBe(0);
});

test('buffer release waits for the native AudioContext before advancing', async () => {
	const {player, audioContext, buffer} = mountPlayer();
	await act(() => player.play());
	await act(() => audioContext.becomeRunning());
	await advance(100);
	expect(player.getCurrentFrame()).toBe(3);
	let handle: ReturnType<typeof buffer> | null = null;
	await act(() => {
		handle = buffer();
	});
	expect(audioContext.state).toBe('suspended');
	now += 5000;
	await act(() => handle?.unblock());
	await advance(0);
	expect(resumeCalls).toBe(2);
	expect(animationFrames.size).toBe(0);
	expect(player.getCurrentFrame()).toBe(3);
	await act(() => audioContext.becomeRunning());
	await advance(100);
	expect(player.getCurrentFrame()).toBe(6);
});

test.each(['pause', 'unmount'] as const)(
	'%s interrupts the clock while native resume is pending',
	async (stop) => {
		resumeResult = 'pending';
		const {player, audioContext, unmount} = mountPlayer();
		await act(() => player.play());
		await act(() => {
			if (stop === 'pause') {
				player.pause();
			} else {
				unmount();
			}
		});
		await act(() => audioContext.becomeRunning());
		await advance(1000);
		expect(animationFrames.size).toBe(0);
		if (stop === 'pause') {
			expect(player.isPlaying()).toBe(false);
			expect(player.getCurrentFrame()).toBe(0);
			expect(audioContext.state).toBe('suspended');
		}
	},
);

import {afterEach, expect, test} from 'bun:test';
import {createRef} from 'react';
import {Html5Audio, Internals, useBufferState} from 'remotion';
import type {PlayerRef} from '../player-methods.js';
import {Player} from '../Player.js';
import {act, cleanup, render, waitFor} from './test-utils.js';

afterEach(() => {
	cleanup();
});

let createdAudioContexts = 0;
let resumeCalls = 0;
let suspendCalls = 0;
let outputClockReads = 0;

class FrozenAudioContext {
	public state = 'suspended' as AudioContextState;
	public baseLatency = 0;
	public outputLatency = 0;
	public currentTime = 0;
	public destination = {};

	constructor() {
		createdAudioContexts++;
	}

	addEventListener() {
		return undefined;
	}

	removeEventListener() {
		return undefined;
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
		suspendCalls++;
		this.state = 'suspended';
		return Promise.resolve();
	}

	resume() {
		resumeCalls++;
		return new Promise<void>(() => undefined);
	}

	getOutputTimestamp() {
		outputClockReads++;
		return {contextTime: 0, performanceTime: 0};
	}

	createMediaElementSource() {
		return {
			connect: () => undefined,
			disconnect: () => undefined,
		};
	}
}

const sequenceManager = {
	registerSequence: () => undefined,
	unregisterSequence: () => undefined,
	updateSequence: null,
	sequences: [],
};

const AudioComposition = () => {
	return (
		<Internals.SequenceManager.Provider value={sequenceManager}>
			<Html5Audio src="audio.mp3" />
		</Internals.SequenceManager.Provider>
	);
};

test('Player stays unmuted and waits when native resume remains pending', async () => {
	const originalAudioContext = globalThis.AudioContext;
	const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
	const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

	let animationFrameId = 0;
	const animationFrames = new Map<number, FrameRequestCallback>();

	globalThis.AudioContext =
		FrozenAudioContext as unknown as typeof AudioContext;
	globalThis.requestAnimationFrame = (callback) => {
		animationFrameId++;
		animationFrames.set(animationFrameId, callback);
		return animationFrameId;
	};

	globalThis.cancelAnimationFrame = (id) => {
		animationFrames.delete(id);
	};

	const flushAnimationFrames = () => {
		const callbacks = [...animationFrames.values()];
		animationFrames.clear();
		callbacks.forEach((callback) => callback(performance.now()));
	};

	try {
		createdAudioContexts = 0;
		resumeCalls = 0;
		const playerRef = createRef<PlayerRef>();
		render(
			<Player
				ref={playerRef}
				component={AudioComposition}
				durationInFrames={300}
				compositionWidth={1920}
				compositionHeight={1080}
				fps={30}
			/>,
		);
		expect(createdAudioContexts).toBe(1);

		await act(async () => {
			playerRef.current?.play();
			await Promise.resolve();
		});
		expect(resumeCalls).toBe(1);
		expect(animationFrames.size).toBe(0);
		const stalledFrame = playerRef.current?.getCurrentFrame();

		await new Promise<void>((resolve) => setTimeout(resolve, 50));
		act(flushAnimationFrames);
		expect(playerRef.current?.getCurrentFrame()).toBe(stalledFrame);
		const initialResumeCalls = resumeCalls;

		await act(async () => {
			await new Promise<void>((resolve) => setTimeout(resolve, 1050));
		});
		expect(animationFrames.size).toBe(0);

		await new Promise<void>((resolve) => setTimeout(resolve, 50));
		act(flushAnimationFrames);

		expect(playerRef.current?.isPlaying()).toBe(true);
		expect(playerRef.current?.isMuted()).toBe(false);
		expect(playerRef.current?.getCurrentFrame()).toBe(stalledFrame);
		expect(resumeCalls).toBe(initialResumeCalls);
		expect(animationFrames.size).toBe(0);

		await act(async () => {
			playerRef.current?.pause();
			await Promise.resolve();
		});
		expect(animationFrames.size).toBe(0);

		await act(async () => {
			playerRef.current?.unmute();
			playerRef.current?.play();
			await Promise.resolve();
		});
		expect(resumeCalls).toBeGreaterThan(initialResumeCalls);
		expect(animationFrames.size).toBe(0);
		const retryResumeCalls = resumeCalls;

		await act(async () => {
			playerRef.current?.pause();
			await Promise.resolve();
		});
		expect(playerRef.current?.isPlaying()).toBe(false);
		expect(animationFrames.size).toBe(0);
		await act(() => {
			playerRef.current?.play();
		});
		await waitFor(() => expect(resumeCalls).toBeGreaterThan(retryResumeCalls));
		const readsBeforeUnmount = outputClockReads;
		cleanup();
		act(flushAnimationFrames);
		expect(outputClockReads).toBe(readsBeforeUnmount);
	} finally {
		globalThis.AudioContext = originalAudioContext;
		globalThis.requestAnimationFrame = originalRequestAnimationFrame;
		globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
	}
});

test('buffering cancels playback while a native resume remains pending', async () => {
	const originalAudioContext = globalThis.AudioContext;
	globalThis.AudioContext =
		FrozenAudioContext as unknown as typeof AudioContext;
	let begin: ReturnType<typeof useBufferState>['delayPlayback'] | null = null;
	const Composition = () => {
		begin = useBufferState().delayPlayback;
		return <AudioComposition />;
	};

	const ref = createRef<PlayerRef>();
	try {
		resumeCalls = 0;
		const view = render(
			<Player
				ref={ref}
				component={Composition}
				durationInFrames={300}
				compositionWidth={320}
				compositionHeight={180}
				fps={30}
			/>,
		);
		await act(() => {
			ref.current?.play();
		});
		await waitFor(() => expect(resumeCalls).toBe(1));
		const suspendedBeforeBuffering = suspendCalls;
		if (!begin) throw new Error('Composition did not mount');
		const delay = begin as ReturnType<typeof useBufferState>['delayPlayback'];
		let handle: ReturnType<typeof delay>;
		await act(() => {
			handle = delay();
		});
		expect(suspendCalls).toBe(suspendedBeforeBuffering);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 1100));
		});
		expect(ref.current?.isMuted()).toBe(false);
		expect(ref.current?.getCurrentFrame()).toBe(0);
		const callsBeforeUnblock = resumeCalls;
		await act(() => {
			handle.unblock();
		});
		await waitFor(() =>
			expect(resumeCalls).toBeGreaterThan(callsBeforeUnblock),
		);
		view.unmount();
	} finally {
		cleanup();
		globalThis.AudioContext = originalAudioContext;
	}
});

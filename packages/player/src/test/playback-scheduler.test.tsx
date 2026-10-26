import {afterEach, beforeEach, expect, spyOn, test} from 'bun:test';
import {cloneElement, createRef} from 'react';
import {useBufferState} from 'remotion';
import type {PlayerRef} from '../player-methods.js';
import {Player} from '../Player.js';
import {act, cleanup, render} from './test-utils.js';

const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
const animationFrames = new Map<number, FrameRequestCallback>();
let animationFrameId = 0;
let now = 1000;
let restoreClock: () => void = () => undefined;

beforeEach(() => {
	now = 1000;
	animationFrameId = 0;
	animationFrames.clear();
	const clock = spyOn(performance, 'now').mockImplementation(() => now);
	const monotonicClock = spyOn(process.hrtime, 'bigint').mockImplementation(
		() => BigInt(now) * BigInt(1_000_000),
	);
	restoreClock = () => {
		clock.mockRestore();
		monotonicClock.mockRestore();
	};

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
	globalThis.requestAnimationFrame = originalRequestAnimationFrame;
	globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
});

const advance = async (milliseconds: number) => {
	now += milliseconds;
	const callbacks = [...animationFrames.values()];
	animationFrames.clear();
	await act(async () => {
		for (const callback of callbacks) {
			callback(now);
		}

		await Promise.resolve();
	});
};

const mountPlayer = (
	options: Partial<{
		initialFrame: number;
		playbackRate: number;
		loop: boolean;
		inFrame: number;
		outFrame: number;
		moveToBeginningWhenEnded: boolean;
	}> = {},
) => {
	let buffering: ReturnType<typeof useBufferState> | null = null;
	const Composition = () => {
		buffering = useBufferState();
		return null;
	};

	const playerRef = createRef<PlayerRef>();
	const element = (
		<Player
			ref={playerRef}
			component={Composition}
			durationInFrames={100}
			compositionWidth={1920}
			compositionHeight={1080}
			fps={10}
			initiallyMuted
			{...options}
		/>
	);
	const {unmount, rerender} = render(element);
	const player = playerRef.current;
	if (!player) {
		throw new Error('Expected mounted Player');
	}

	return {
		player,
		unmount,
		setPlaybackRate: (playbackRate: number) => {
			rerender(cloneElement(element, {playbackRate}));
		},
		buffer: () => {
			if (!buffering) {
				throw new Error('Expected composition buffering controls');
			}

			return buffering.delayPlayback();
		},
	};
};

test.each(['pause', 'unmount'] as const)(
	'%s cancels the queued playback frame and ignores a stale browser callback',
	async (stop) => {
		const {player, unmount} = mountPlayer();
		const frames: number[] = [];
		player.addEventListener('frameupdate', ({detail}) => {
			frames.push(detail.frame);
		});
		await act(() => player.play());
		expect(animationFrames.size).toBe(1);
		await advance(100);
		expect(player.getCurrentFrame()).toBe(1);
		const queuedCallbacks = [...animationFrames.values()];

		await act(() => {
			if (stop === 'pause') {
				player.pause();
			} else {
				unmount();
			}
		});
		for (const callback of queuedCallbacks) {
			expect([...animationFrames.values()]).not.toContain(callback);
		}

		await advance(0);
		expect(animationFrames.size).toBe(0);

		now += 1000;
		await act(() => {
			for (const callback of queuedCallbacks) {
				callback(now);
			}
		});
		expect(animationFrames.size).toBe(0);
		expect(frames).toEqual([1]);
	},
);

test('buffering freezes playback and resumes without counting stalled time', async () => {
	const {player, buffer} = mountPlayer();
	await act(() => player.play());
	await advance(100);
	let handle: ReturnType<typeof buffer> | null = null;
	await act(() => {
		handle = buffer();
	});
	await advance(100);
	expect(player.getCurrentFrame()).toBe(1);
	expect(animationFrames.size).toBe(0);

	now += 5000;
	await act(() => handle?.unblock());
	await advance(0);
	expect(animationFrames.size).toBe(1);
	await advance(100);
	expect(player.getCurrentFrame()).toBe(2);
	expect(player.isPlaying()).toBe(true);
});

test.each(['pause', 'unmount'] as const)(
	'%s during buffering does not restart the old playback when unblocked',
	async (stop) => {
		const {player, buffer, unmount} = mountPlayer();
		await act(() => player.play());
		let handle: ReturnType<typeof buffer> | null = null;
		await act(() => {
			handle = buffer();
		});
		await advance(100);
		expect(animationFrames.size).toBe(0);

		await act(() => {
			if (stop === 'pause') {
				player.pause();
			} else {
				unmount();
			}
		});
		now += 5000;
		await act(() => handle?.unblock());
		await advance(0);
		expect(animationFrames.size).toBe(0);

		if (stop === 'pause') {
			expect(player.isPlaying()).toBe(false);
			await act(() => player.play());
			expect(animationFrames.size).toBe(1);
			await advance(100);
			expect(player.getCurrentFrame()).toBe(1);
		}
	},
);

test('seeking during playback continues from the sought frame', async () => {
	const {player} = mountPlayer();
	await act(() => player.play());
	await advance(200);
	expect(player.getCurrentFrame()).toBe(2);
	await act(() => player.seekTo(40));
	expect(player.getCurrentFrame()).toBe(40);
	expect(animationFrames.size).toBe(1);
	await advance(100);
	expect(player.getCurrentFrame()).toBe(41);
	expect(player.isPlaying()).toBe(true);
});

test('buffering and stopping one Player do not affect another Player', async () => {
	const first = mountPlayer({initialFrame: 10});
	const second = mountPlayer({initialFrame: 20});
	await act(() => {
		first.player.play();
		second.player.play();
	});
	expect(animationFrames.size).toBe(2);
	await advance(100);
	expect(first.player.getCurrentFrame()).toBe(11);
	expect(second.player.getCurrentFrame()).toBe(21);

	let handle: ReturnType<typeof first.buffer> | null = null;
	await act(() => {
		handle = first.buffer();
	});
	await advance(100);
	expect(first.player.getCurrentFrame()).toBe(11);
	expect(second.player.getCurrentFrame()).toBe(22);
	expect(animationFrames.size).toBe(1);

	await act(() => first.player.pause());
	await act(() => handle?.unblock());
	await advance(0);
	expect(first.player.isPlaying()).toBe(false);
	expect(second.player.isPlaying()).toBe(true);
	expect(animationFrames.size).toBe(1);
	await advance(100);
	expect(first.player.getCurrentFrame()).toBe(11);
	expect(second.player.getCurrentFrame()).toBe(23);
	const secondCallback = [...animationFrames.values()][0];

	await act(() => first.unmount());
	expect([...animationFrames.values()]).toContain(secondCallback);
	await advance(100);
	expect(second.player.getCurrentFrame()).toBe(24);
	expect(animationFrames.size).toBe(1);
});

test('changing playbackRate replaces the queued frame and keeps the current position', async () => {
	const {player, setPlaybackRate} = mountPlayer({initialFrame: 10});
	await act(() => player.play());
	await advance(200);
	expect(player.getCurrentFrame()).toBe(12);
	const previousCallback = [...animationFrames.values()][0];

	await act(() => setPlaybackRate(2));
	expect(player.getCurrentFrame()).toBe(12);
	expect(player.isPlaying()).toBe(true);
	expect(animationFrames.size).toBe(1);
	expect([...animationFrames.values()]).not.toContain(previousCallback);
	await act(() => previousCallback(now));
	expect(player.getCurrentFrame()).toBe(12);
	expect(animationFrames.size).toBe(1);
	await advance(100);
	expect(player.getCurrentFrame()).toBe(14);
	await advance(100);
	expect(player.getCurrentFrame()).toBe(16);
});

test('visibility changes swap RAF and background timers, and pause cancels the timer', async () => {
	const originalVisibility = Object.getOwnPropertyDescriptor(
		document,
		'visibilityState',
	);
	let visibility: DocumentVisibilityState = 'visible';
	Object.defineProperty(document, 'visibilityState', {
		configurable: true,
		get: () => visibility,
	});
	const timers = spyOn(globalThis, 'setTimeout');
	const cancelledTimers = spyOn(globalThis, 'clearTimeout');
	const backgroundTimer = () => {
		const index = timers.mock.calls.findLastIndex(([, delay]) => delay === 100);
		expect(index).toBeGreaterThanOrEqual(0);
		return {
			callback: timers.mock.calls[index][0],
			id: timers.mock.results[index].value,
		};
	};

	try {
		const {player} = mountPlayer();
		await act(() => player.play());
		expect(animationFrames.size).toBe(1);
		now += 100;
		visibility = 'hidden';
		await act(() => {
			document.dispatchEvent(new Event('visibilitychange'));
		});
		expect(player.getCurrentFrame()).toBe(1);
		expect(animationFrames.size).toBe(0);
		const firstTimer = backgroundTimer();

		now += 100;
		await act(() => firstTimer.callback());
		expect(player.getCurrentFrame()).toBe(2);
		const secondTimer = backgroundTimer();

		visibility = 'visible';
		await act(() => {
			document.dispatchEvent(new Event('visibilitychange'));
		});
		expect(cancelledTimers).toHaveBeenCalledWith(secondTimer.id);
		expect(animationFrames.size).toBe(1);
		await advance(100);
		expect(player.getCurrentFrame()).toBe(3);

		visibility = 'hidden';
		await act(() => {
			document.dispatchEvent(new Event('visibilitychange'));
		});
		const finalTimer = backgroundTimer();
		await act(() => player.pause());
		expect(cancelledTimers).toHaveBeenCalledWith(finalTimer.id);
		await act(() => finalTimer.callback());
		expect(animationFrames.size).toBe(0);
		expect(player.getCurrentFrame()).toBe(3);
	} finally {
		cleanup();
		timers.mockRestore();
		cancelledTimers.mockRestore();
		if (originalVisibility) {
			Object.defineProperty(document, 'visibilityState', originalVisibility);
		} else {
			Reflect.deleteProperty(document, 'visibilityState');
		}
	}
});

test.each([
	{playbackRate: 2, expectedFrame: 24},
	{playbackRate: -2, expectedFrame: 16},
])(
	'playback rate $playbackRate advances in the configured direction',
	async ({playbackRate, expectedFrame}) => {
		const {player} = mountPlayer({initialFrame: 20, playbackRate});
		await act(() => player.play());
		await advance(200);
		expect(player.getCurrentFrame()).toBe(expectedFrame);
		expect(animationFrames.size).toBe(1);
	},
);

test.each([
	{playbackRate: 1, initialFrame: 13, expectedFrame: 10},
	{playbackRate: -1, initialFrame: 11, expectedFrame: 14},
])(
	'looping at rate $playbackRate wraps inside the playback range',
	async ({playbackRate, initialFrame, expectedFrame}) => {
		const {player} = mountPlayer({
			initialFrame,
			playbackRate,
			loop: true,
			inFrame: 10,
			outFrame: 14,
		});
		let ended = 0;
		player.addEventListener('ended', () => ended++);
		await act(() => player.play());
		await advance(200);
		expect(player.getCurrentFrame()).toBe(expectedFrame);
		expect(player.isPlaying()).toBe(true);
		expect(ended).toBe(0);
		expect(animationFrames.size).toBe(1);
	},
);

test.each([
	{moveToBeginningWhenEnded: true},
	{moveToBeginningWhenEnded: false},
])(
	'ending playback dispatches once with moveToBeginningWhenEnded=$moveToBeginningWhenEnded',
	async ({moveToBeginningWhenEnded}) => {
		const {player} = mountPlayer({
			initialFrame: 13,
			inFrame: 10,
			outFrame: 14,
			moveToBeginningWhenEnded,
		});
		const events: string[] = [];
		player.addEventListener('pause', () => events.push('pause'));
		player.addEventListener('ended', () => events.push('ended'));
		await act(() => player.play());
		await advance(100);
		expect(player.getCurrentFrame()).toBe(14);
		await advance(100);
		expect(player.getCurrentFrame()).toBe(moveToBeginningWhenEnded ? 10 : 14);
		expect(player.isPlaying()).toBe(false);
		expect(animationFrames.size).toBe(0);
		await advance(1000);
		expect(events).toEqual(['pause', 'ended']);
	},
);

test('frameupdate follows changed frames while timeupdate is throttled', async () => {
	const {player} = mountPlayer();
	const frames: number[] = [];
	const timeUpdates: number[] = [];
	player.addEventListener('frameupdate', ({detail}) => {
		frames.push(detail.frame);
	});
	player.addEventListener('timeupdate', ({detail}) => {
		timeUpdates.push(detail.frame);
	});
	await act(() => player.play());
	await advance(100);
	await advance(50);
	expect(frames).toEqual([1]);
	expect(timeUpdates).toEqual([]);
	await advance(150);
	expect(frames).toEqual([1, 3]);
	expect(timeUpdates).toEqual([3]);
});

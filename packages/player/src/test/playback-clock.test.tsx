import {afterEach, expect, test} from 'bun:test';
import {createRef} from 'react';
import {useBufferState} from 'remotion';
import type {PlayerRef} from '../player-methods.js';
import {Player} from '../Player.js';
import {act, cleanup, render, waitFor} from './test-utils.js';

afterEach(cleanup);

test('time updates deliver the latest seek and cancel pending delivery on unmount', async () => {
	const ref = createRef<PlayerRef>();
	const view = render(
		<Player
			ref={ref}
			component={() => null}
			durationInFrames={300}
			fps={30}
			compositionWidth={320}
			compositionHeight={180}
			initiallyMuted
		/>,
	);
	const frames: number[] = [];
	ref.current?.addEventListener('timeupdate', ({detail}) =>
		frames.push(detail.frame),
	);
	await act(() => {
		ref.current?.seekTo(3);
	});
	await act(() => {
		ref.current?.seekTo(7);
	});
	await waitFor(() => expect(frames).toEqual([7]));
	await act(() => {
		ref.current?.seekTo(8);
	});
	view.unmount();
	await new Promise((resolve) => setTimeout(resolve, 300));
	expect(frames).toEqual([7]);
});

test('unmount prevents a buffered clock from restarting', async () => {
	let delayPlayback: ReturnType<typeof useBufferState>['delayPlayback'] | null =
		null;
	const Composition = () => {
		delayPlayback = useBufferState().delayPlayback;
		return null;
	};

	const ref = createRef<PlayerRef>();
	const originalRaf = globalThis.requestAnimationFrame;
	const originalCancel = globalThis.cancelAnimationFrame;
	const frames = new Map<number, FrameRequestCallback>();
	let id = 0;
	globalThis.requestAnimationFrame = (callback) => {
		frames.set(++id, callback);
		return id;
	};

	globalThis.cancelAnimationFrame = (frameId) => {
		frames.delete(frameId);
	};

	try {
		const view = render(
			<Player
				ref={ref}
				component={Composition}
				durationInFrames={300}
				fps={30}
				compositionWidth={320}
				compositionHeight={180}
				initiallyMuted
			/>,
		);
		await act(() => {
			ref.current?.play();
		});
		await waitFor(() => expect(frames.size).toBeGreaterThan(0));
		if (!delayPlayback) throw new Error('Composition did not mount');
		const begin = delayPlayback as ReturnType<
			typeof useBufferState
		>['delayPlayback'];
		let handle: ReturnType<typeof begin>;
		await act(() => {
			handle = begin();
		});
		await act(() => {
			view.unmount();
		});
		const queuedAfterUnmount = frames.size;
		await act(() => {
			handle.unblock();
		});
		expect(frames.size).toBe(queuedAfterUnmount);
	} finally {
		globalThis.requestAnimationFrame = originalRaf;
		globalThis.cancelAnimationFrame = originalCancel;
	}
});

test('a paused buffered player does not restart when media becomes ready', async () => {
	let delayPlayback: ReturnType<typeof useBufferState>['delayPlayback'] | null =
		null;
	const Composition = () => {
		delayPlayback = useBufferState().delayPlayback;
		return null;
	};

	const ref = createRef<PlayerRef>();
	render(
		<Player
			ref={ref}
			component={Composition}
			durationInFrames={300}
			fps={30}
			compositionWidth={320}
			compositionHeight={180}
			initiallyMuted
		/>,
	);
	if (!delayPlayback) throw new Error('Composition did not mount');
	const begin = delayPlayback as ReturnType<
		typeof useBufferState
	>['delayPlayback'];
	let handle: ReturnType<typeof begin>;
	await act(() => {
		ref.current?.play();
		handle = begin();
	});
	await act(() => {
		ref.current?.pause();
	});
	const frame = ref.current?.getCurrentFrame();
	await act(async () => {
		handle.unblock();
		await new Promise((resolve) => setTimeout(resolve, 100));
	});
	expect(ref.current?.isPlaying()).toBe(false);
	expect(ref.current?.getCurrentFrame()).toBe(frame);
});

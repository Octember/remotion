import {afterEach, beforeEach, expect, test} from 'bun:test';
import {act, cleanup, render} from '@testing-library/react';
import React, {useContext, useLayoutEffect} from 'react';
import {
	SharedAudioContext,
	SharedAudioContextProvider,
} from '../audio/shared-audio-tags.js';
import {RemotionEnvironmentContext} from '../remotion-environment-context.js';

class ControlledAudioContext extends EventTarget {
	public state: AudioContextState = 'suspended';
	public currentTime = 0;
	public destination = {};
	public resumes: Array<{
		resolve: () => void;
		reject: (error: Error) => void;
	}> = [];

	public suspendCalls = 0;
	public stateListeners = new Set<EventListenerOrEventListenerObject>();

	addEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
	) {
		if (type === 'statechange' && listener) this.stateListeners.add(listener);
		super.addEventListener(type, listener);
	}

	removeEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject | null,
	) {
		if (type === 'statechange' && listener) {
			this.stateListeners.delete(listener);
		}

		super.removeEventListener(type, listener);
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

	resume() {
		return new Promise<void>((resolve, reject) => {
			this.resumes.push({resolve, reject});
		});
	}

	suspend() {
		this.suspendCalls++;
		this.state = 'suspended';
		return Promise.resolve();
	}

	start() {
		this.state = 'running';
		this.dispatchEvent(new Event('statechange'));
		this.resumes.forEach(({resolve}) => resolve());
	}
}

const originalAudioContext = globalThis.AudioContext;

beforeEach(() => {
	globalThis.AudioContext =
		ControlledAudioContext as unknown as typeof AudioContext;
});

afterEach(() => {
	cleanup();
	globalThis.AudioContext = originalAudioContext;
});

const previewEnvironment = {
	isClientSideRendering: false,
	isPlayer: true,
	isReadOnlyStudio: false,
	isRendering: false,
	isStudio: false,
};

const Provider: React.FC<{readonly children: React.ReactNode}> = ({
	children,
}) => (
	<RemotionEnvironmentContext.Provider value={previewEnvironment}>
		<SharedAudioContextProvider
			audioEnabled
			audioLatencyHint="interactive"
			previewSampleRate={null}
			_experimentalKeepAudioContextAlive={false}
		>
			{children}
		</SharedAudioContextProvider>
	</RemotionEnvironmentContext.Provider>
);

const renderProvider = () => {
	const ref: {current: React.ContextType<typeof SharedAudioContext>} = {
		current: null,
	};
	const Probe = () => {
		ref.current = useContext(SharedAudioContext);
		return null;
	};

	const rendered = render(
		<Provider>
			<Probe />
		</Provider>,
	);
	if (!ref.current) throw new Error('Expected shared audio context');
	const context = ref.current;
	return {
		...rendered,
		value: context,
		native: context.audioContext as unknown as ControlledAudioContext,
	};
};

test('anchor PubSub broadcasts synchronously and releases each subscription', () => {
	const {value} = renderProvider();
	const events: string[] = [];
	const first = value.audioSyncAnchorEmitter.subscribe(() => events.push('a'));
	const second = value.audioSyncAnchorEmitter.subscribe(() => events.push('b'));
	value.audioSyncAnchorEmitter.dispatch('changed');
	expect(events).toEqual(['a', 'b']);

	first.remove();
	first.remove();
	value.audioSyncAnchorEmitter.dispatch('changed');
	expect(events).toEqual(['a', 'b', 'b']);
	second.remove();
	value.audioSyncAnchorEmitter.dispatch('changed');

	const late = value.audioSyncAnchorEmitter.subscribe(() => events.push('c'));
	expect(events).toEqual(['a', 'b', 'b']);
	value.audioSyncAnchorEmitter.dispatch('changed');
	expect(events).toEqual(['a', 'b', 'b', 'c']);
	late.remove();
});

test('a layout-effect subscriber is available to an immediate publisher', () => {
	const {value} = renderProvider();
	const events: string[] = [];
	const Subscriber = () => {
		useLayoutEffect(() => {
			return value.audioSyncAnchorEmitter.subscribe(() =>
				events.push('changed'),
			).remove;
		}, []);
		return null;
	};

	const subscriber = render(<Subscriber />);
	value.audioSyncAnchorEmitter.dispatch('changed');
	expect(events).toEqual(['changed']);
	subscriber.unmount();
	value.audioSyncAnchorEmitter.dispatch('changed');
	expect(events).toEqual(['changed']);
});

test('a pending native resume can be retried synchronously by the next gesture', async () => {
	const {value, native} = renderProvider();
	value.resume();
	expect(native.resumes).toHaveLength(1);
	const barrier = value.getIsResumingAudioContext();
	expect(barrier).not.toBeNull();
	value.resume();
	expect(native.resumes).toHaveLength(2);
	expect(value.getIsResumingAudioContext()).toBe(barrier);
	expect(native.stateListeners.size).toBe(1);

	native.start();
	expect(await barrier).toBe('resumed');
	expect(value.getIsResumingAudioContext()).toBeNull();
	expect(native.stateListeners.size).toBe(0);
	await value.resume();
	expect(native.resumes).toHaveLength(2);
});

test('native resume rejection keeps the barrier buffered for another gesture', async () => {
	const {value, native} = renderProvider();
	const firstResume = value.resume();
	const barrier = value.getIsResumingAudioContext();
	native.resumes[0].reject(new Error('Autoplay denied'));
	await firstResume;
	expect(value.getIsResumingAudioContext()).toBe(barrier);
	let settled = false;
	barrier?.then(() => {
		settled = true;
	});
	await Promise.resolve();
	expect(settled).toBe(false);

	value.resume();
	expect(native.resumes).toHaveLength(2);
	native.start();
	expect(await barrier).toBe('resumed');
});

test('native resume fulfillment alone does not release a suspended context', async () => {
	const {value, native} = renderProvider();
	const resumed = value.resume();
	const barrier = value.getIsResumingAudioContext();
	native.resumes[0].resolve();
	await resumed;
	expect(native.state).toBe('suspended');
	expect(value.getIsResumingAudioContext()).toBe(barrier);
	let settled = false;
	barrier?.then(() => {
		settled = true;
	});
	await Promise.resolve();
	expect(settled).toBe(false);
	native.start();
	expect(await barrier).toBe('resumed');
});

test('pause during a pending resume suspends only after the context runs', async () => {
	const {value, native} = renderProvider();
	await Promise.resolve();
	const initialSuspends = native.suspendCalls;
	value.resume();
	const paused = value.suspend();
	expect(native.suspendCalls).toBe(initialSuspends);
	native.start();
	await paused;
	expect(native.suspendCalls).toBe(initialSuspends + 1);
	expect(native.state).toBe('suspended');
});

test('playing again before a pending resume completes cancels deferred suspension', async () => {
	const {value, native} = renderProvider();
	await Promise.resolve();
	const initialSuspends = native.suspendCalls;
	value.resume();
	const paused = value.suspend();
	value.resume();
	native.start();
	await paused;
	expect(native.suspendCalls).toBe(initialSuspends);
	expect(native.state).toBe('running');
});

test('provider unmount interrupts the resume barrier and releases its native listener', async () => {
	const {value, native, unmount} = renderProvider();
	value.resume();
	const barrier = value.getIsResumingAudioContext();
	expect(native.stateListeners.size).toBe(1);
	act(() => unmount());
	expect(await barrier).toBe('cancelled');
	expect(native.stateListeners.size).toBe(0);
});

test('separate providers do not share resume barriers or anchor events', async () => {
	const first = renderProvider();
	const second = renderProvider();
	const events: string[] = [];
	const subscription = second.value.audioSyncAnchorEmitter.subscribe(() => {
		events.push('second');
	});
	first.value.audioSyncAnchorEmitter.dispatch('changed');
	expect(events).toEqual([]);
	first.value.resume();
	second.value.resume();
	const firstBarrier = first.value.getIsResumingAudioContext();
	const secondBarrier = second.value.getIsResumingAudioContext();
	first.unmount();
	expect(await firstBarrier).toBe('cancelled');
	expect(second.native.stateListeners.size).toBe(1);
	second.native.start();
	expect(await secondBarrier).toBe('resumed');
	second.value.audioSyncAnchorEmitter.dispatch('changed');
	expect(events).toEqual(['second']);
	subscription.remove();
});

test('StrictMode replay replaces the cancelled barrier and subscription', async () => {
	const barriers: Array<
		ReturnType<
			NonNullable<
				React.ContextType<typeof SharedAudioContext>
			>['getIsResumingAudioContext']
		>
	> = [];
	const events: string[] = [];
	let native: ControlledAudioContext | null = null;
	const Probe = () => {
		const value = useContext(SharedAudioContext);
		useLayoutEffect(() => {
			if (!value) throw new Error('Expected shared audio context');
			native = value.audioContext as unknown as ControlledAudioContext;
			value.resume();
			barriers.push(value.getIsResumingAudioContext());
			const subscription = value.audioSyncAnchorEmitter.subscribe(() => {
				events.push('changed');
			});
			value.audioSyncAnchorEmitter.dispatch('changed');
			return subscription.remove;
		}, [value]);
		return null;
	};

	render(
		<React.StrictMode>
			<Provider>
				<Probe />
			</Provider>
		</React.StrictMode>,
	);
	expect(barriers).toHaveLength(2);
	expect(events).toEqual(['changed', 'changed']);
	expect(await barriers[0]).toBe('cancelled');
	expect(barriers[0]).not.toBe(barriers[1]);
	if (!native) throw new Error('Expected native audio context');
	const active = native as ControlledAudioContext;
	expect(active.stateListeners.size).toBe(1);
	active.start();
	expect(await barriers[1]).toBe('resumed');
	expect(active.stateListeners.size).toBe(0);
});

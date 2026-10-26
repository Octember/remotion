import {Player} from '@remotion/player';
import {Effect, PubSub} from 'effect';
import React, {useContext} from 'react';
import {createRoot} from 'react-dom/client';
import {Internals} from 'remotion';
import {expect, test} from 'vitest';

test('audio clock broadcasts the latest anchor to every scoped subscriber', async () => {
	const observed: {
		audio: React.ContextType<typeof Internals.SharedAudioContext>;
	} = {audio: null};
	const Composition = () => {
		observed.audio = useContext(Internals.SharedAudioContext);
		return null;
	};

	const container = document.createElement('div');
	document.body.appendChild(container);
	const root = createRoot(container);
	root.render(
		<Player
			component={Composition}
			durationInFrames={300}
			fps={30}
			compositionWidth={320}
			compositionHeight={180}
			acknowledgeRemotionLicense
		/>,
	);
	try {
		await expect.poll(() => observed.audio?.audioContext).toBeTruthy();
		const {audio} = observed;
		if (!audio?.audioContext) throw new Error('Audio context did not mount');
		const context = audio.audioContext;
		const clock = audio.audioSyncAnchor;
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const first = yield* PubSub.subscribe(clock.changes);
					const second = yield* PubSub.subscribe(clock.changes);
					for (const absoluteTimeInSeconds of [1, 2]) {
						clock.synchronize({
							audioContext: context,
							absoluteTimeInSeconds,
							globalPlaybackRate: 1,
							logLevel: 'error',
							force: true,
						});
					}

					const expected = clock.value;
					expect(expected).toBeLessThan(0);
					expect(yield* PubSub.take(first)).toBe(expected);
					expect(yield* PubSub.take(second)).toBe(expected);
					clock.synchronize({
						audioContext: context,
						absoluteTimeInSeconds: 2.01,
						globalPlaybackRate: 1,
						logLevel: 'error',
						force: false,
					});
					expect(clock.value).toBe(expected);
				}),
			),
		);
		expect(Effect.runSync(PubSub.size(clock.changes))).toBe(0);
	} finally {
		root.unmount();
		container.remove();
	}
});

import {Clock, Effect, Fiber, PubSub} from 'effect';
import {useContext, useEffect, useLayoutEffect, useRef} from 'react';
import {Internals} from 'remotion';
import type {RemotionAudioContextState} from 'remotion';
import type {BrowserMediaControlsBehavior} from './browser-mediasession.js';
import {useBrowserMediaSession} from './browser-mediasession.js';
import {calculateNextFrame} from './calculate-next-frame.js';
import {setGlobalTimeAnchor} from './set-global-time-anchor.js';
import {type UsePlayerMethods, usePlayerMethods} from './use-player-methods.js';

const monotonicTimeMillis = Effect.map(
	Clock.monotonicTimeNanos,
	(nanos) => Number(nanos) / 1_000_000,
);

const shouldForceAnchorChange = (newState: RemotionAudioContextState) => {
	if (newState === 'suspended' || newState === 'running-to-suspended') {
		return true;
	}

	if (
		newState === 'closed' ||
		newState === 'interrupted' ||
		newState === 'running' ||
		newState === 'suspended-to-running'
	) {
		return false;
	}

	throw new Error(
		`Unexpected audio context state: ${newState satisfies never}`,
	);
};

export const usePlayback = ({
	loop,
	playbackRate,
	moveToBeginningWhenEnded,
	inFrame,
	outFrame,
	browserMediaControlsBehavior,
	getCurrentFrame,
	muted,
}: {
	loop: boolean;
	playbackRate: number;
	moveToBeginningWhenEnded: boolean;
	inFrame: number | null;
	outFrame: number | null;
	browserMediaControlsBehavior: BrowserMediaControlsBehavior;
	getCurrentFrame: UsePlayerMethods['getCurrentFrame'];
	muted: boolean;
}) => {
	const config = Internals.useUnsafeVideoConfig();
	const frame = Internals.Timeline.useTimelinePosition();
	const playing = Internals.usePlaying();
	const {pause, emitter, isPlaying} = usePlayerMethods();
	const setFrame = Internals.Timeline.useTimelineSetFrame();
	const sharedAudioContext = useContext(Internals.SharedAudioContext);
	const {isBuffering, subscribeBuffering} = useContext(
		Internals.SetTimelineContext,
	);
	const logLevel = Internals.useLogLevel();

	const lastTimeUpdateTimestamp = useRef<number>(0);

	useBrowserMediaSession({
		browserMediaControlsBehavior,
		playbackRate,
		videoConfig: config,
	});

	// Update time anchor when seeking:
	// If the user clicked on a different time in the timeline, we need to re-sync the anchor
	useLayoutEffect(() => {
		if (!sharedAudioContext) {
			return;
		}

		if (!sharedAudioContext.audioContext) {
			return;
		}

		if (!config) {
			return;
		}

		if (muted) {
			return;
		}

		const changed = setGlobalTimeAnchor({
			audioContext: sharedAudioContext.audioContext,
			audioSyncAnchor: sharedAudioContext.audioSyncAnchor,
			absoluteTimeInSeconds: frame / config.fps,
			globalPlaybackRate: playbackRate,
			logLevel,
			force: false,
		});
		if (changed) {
			sharedAudioContext.audioSyncAnchorEmitter.dispatch('changed');
		}
	}, [config, frame, logLevel, playbackRate, sharedAudioContext, muted]);

	// When the audio context is suspended, we use the opportunity to
	// re-anchor the time to be exact.
	useLayoutEffect(() => {
		const audioContext = sharedAudioContext?.audioContext;
		if (!audioContext) {
			return;
		}

		if (!config) {
			return;
		}

		if (muted) {
			return;
		}

		const callback = () => {
			const newState = sharedAudioContext?.getAudioContextState();
			if (newState && shouldForceAnchorChange(newState)) {
				setGlobalTimeAnchor({
					audioContext,
					audioSyncAnchor: sharedAudioContext.audioSyncAnchor,
					absoluteTimeInSeconds: getCurrentFrame() / config.fps,
					globalPlaybackRate: playbackRate,
					logLevel,
					force: true,
				});
			}
		};

		audioContext?.addEventListener('statechange', callback);
		return () => {
			audioContext?.removeEventListener('statechange', callback);
		};
	}, [
		config,
		getCurrentFrame,
		logLevel,
		muted,
		playbackRate,
		sharedAudioContext,
	]);

	useEffect(() => {
		if (!config) {
			return;
		}

		if (!playing) {
			sharedAudioContext?.suspend?.();
			return;
		}

		const reanchor = () => {
			if (
				sharedAudioContext?._experimentalKeepAudioContextAlive &&
				sharedAudioContext.audioContext &&
				!muted
			) {
				const changed = setGlobalTimeAnchor({
					audioContext: sharedAudioContext.audioContext,
					audioSyncAnchor: sharedAudioContext.audioSyncAnchor,
					absoluteTimeInSeconds: getCurrentFrame() / config.fps,
					globalPlaybackRate: playbackRate,
					logLevel,
					force: true,
				});
				if (changed) {
					sharedAudioContext.audioSyncAnchorEmitter.dispatch('changed');
				}
			}
		};

		reanchor();

		const clock = Effect.runFork(
			Effect.scoped(
				Effect.gen(function* () {
					const events = yield* Effect.acquireRelease(
						PubSub.sliding<'frame' | 'buffering' | 'visibility'>(1),
						PubSub.shutdown,
					);
					const subscription = yield* PubSub.subscribe(events);

					yield* Effect.acquireRelease(
						Effect.sync(() =>
							subscribeBuffering(() => {
								PubSub.publishUnsafe(events, 'buffering');
							}),
						),
						(unsubscribe) => Effect.sync(unsubscribe),
					);
					const visibilityChanged = () => {
						PubSub.publishUnsafe(events, 'visibility');
					};

					yield* Effect.acquireRelease(
						Effect.sync(() => {
							document.addEventListener('visibilitychange', visibilityChanged);
						}),
						() =>
							Effect.sync(() => {
								document.removeEventListener(
									'visibilitychange',
									visibilityChanged,
								);
							}),
					);
					const nextEvent = Effect.scoped(
						Effect.gen(function* () {
							const tick = () => {
								PubSub.publishUnsafe(events, 'frame');
							};

							if (document.visibilityState === 'hidden') {
								yield* Effect.forkScoped(
									Effect.delay(
										PubSub.publish(events, 'frame'),
										1000 / config.fps,
									),
								);
							} else {
								yield* Effect.acquireRelease(
									Effect.sync(() => requestAnimationFrame(tick)),
									(id) => Effect.sync(() => cancelAnimationFrame(id)),
								);
							}

							return yield* PubSub.take(subscription);
						}),
					);
					let startedTime = yield* monotonicTimeMillis;
					let framesAdvanced = 0;

					while (isPlaying()) {
						const resuming = sharedAudioContext?.getIsResumingAudioContext();
						if (resuming && !muted) {
							const result = yield* Effect.promise(() => resuming);
							if (result === 'cancelled') {
								return;
							}

							startedTime = yield* monotonicTimeMillis;
							framesAdvanced = 0;
							continue;
						}

						if (isBuffering()) {
							if (!muted) {
								sharedAudioContext?.suspend();
							}

							while (isBuffering()) {
								yield* PubSub.take(subscription);
							}

							if (!muted && isPlaying()) {
								reanchor();
								sharedAudioContext?.resume();
							}

							startedTime = yield* monotonicTimeMillis;
							framesAdvanced = 0;
							continue;
						}

						const event = yield* nextEvent;
						if (event === 'buffering' || !isPlaying() || isBuffering()) {
							continue;
						}

						if (!muted) {
							sharedAudioContext?.resume();
						}

						const {nextFrame, framesToAdvance, hasEnded} = calculateNextFrame({
							time: (yield* monotonicTimeMillis) - startedTime,
							currentFrame: getCurrentFrame(),
							playbackSpeed: playbackRate,
							fps: config.fps,
							actualFirstFrame: inFrame ?? 0,
							actualLastFrame: outFrame ?? config.durationInFrames - 1,
							framesAdvanced,
							shouldLoop: loop,
						});
						framesAdvanced += framesToAdvance;
						if (
							nextFrame !== getCurrentFrame() &&
							(!hasEnded || moveToBeginningWhenEnded)
						) {
							setFrame((c) => ({...c, [config.id]: nextFrame}));
						}

						if (hasEnded) {
							pause();
							emitter.dispatchEnded();
							return;
						}
					}
				}),
			),
		);

		return () => Effect.runSync(Fiber.interrupt(clock));
	}, [
		config,
		loop,
		pause,
		playing,
		setFrame,
		emitter,
		playbackRate,
		inFrame,
		outFrame,
		moveToBeginningWhenEnded,
		getCurrentFrame,
		isBuffering,
		isPlaying,
		sharedAudioContext,
		subscribeBuffering,
		logLevel,
		muted,
	]);

	useEffect(() => {
		const update = Effect.runFork(
			Effect.gen(function* () {
				const now = yield* monotonicTimeMillis;
				const timeSinceLastUpdate = now - lastTimeUpdateTimestamp.current;
				if (timeSinceLastUpdate < 250) {
					yield* Effect.sleep(250 - timeSinceLastUpdate);
				}

				emitter.dispatchTimeUpdate({frame});
				lastTimeUpdateTimestamp.current = yield* monotonicTimeMillis;
			}),
		);

		return () => Effect.runSync(Fiber.interrupt(update));
	}, [emitter, frame]);

	useEffect(() => {
		emitter.dispatchFrameUpdate({frame});
	}, [emitter, frame]);
};

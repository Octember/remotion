import {Clock, Effect} from 'effect';
import {useLayoutEffect} from 'react';
import {useContext, useEffect, useRef} from 'react';
import {Internals} from 'remotion';
import type {BrowserMediaControlsBehavior} from './browser-mediasession.js';
import {useBrowserMediaSession} from './browser-mediasession.js';
import {playbackClock} from './playback-clock.js';
import {type UsePlayerMethods, usePlayerMethods} from './use-player-methods.js';

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
	const {setPlayerMuted} = useContext(Internals.SetMediaVolumeContext);
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
		if (!sharedAudioContext?.audioContext || !config || muted) return;

		sharedAudioContext.audioSyncAnchor.synchronize({
			audioContext: sharedAudioContext.audioContext,
			absoluteTimeInSeconds: frame / config.fps,
			globalPlaybackRate: playbackRate,
			logLevel,
			force: false,
		});
	}, [config, frame, logLevel, playbackRate, sharedAudioContext, muted]);

	// When the audio context is suspended, we use the opportunity to
	// re-anchor the time to be exact.
	useLayoutEffect(() => {
		const audioContext = sharedAudioContext?.audioContext;
		if (!audioContext || !config || muted) return;

		const callback = () => {
			const newState = sharedAudioContext?.getAudioContextState();
			if (newState === 'suspended' || newState === 'running-to-suspended') {
				sharedAudioContext.audioSyncAnchor.synchronize({
					audioContext,
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

		if (
			sharedAudioContext?._experimentalKeepAudioContextAlive &&
			sharedAudioContext.audioContext &&
			!muted
		) {
			sharedAudioContext.audioSyncAnchor.synchronize({
				audioContext: sharedAudioContext.audioContext,
				absoluteTimeInSeconds: getCurrentFrame() / config.fps,
				globalPlaybackRate: playbackRate,
				logLevel,
				force: true,
			});
		}

		return Effect.runCallback(
			playbackClock({
				fps: config.fps,
				firstFrame: inFrame ?? 0,
				lastFrame: outFrame ?? config.durationInFrames - 1,
				playbackRate,
				loop,
				moveToBeginningWhenEnded,
				muted,
				audio: sharedAudioContext,
				getCurrentFrame,
				isPlaying,
				isBuffering,
				subscribeBuffering,
				setFrame: (nextFrame) =>
					setFrame((current) => ({...current, [config.id]: nextFrame})),
				setMuted: () => setPlayerMuted(true),
				onEnded: () => {
					pause();
					emitter.dispatchEnded();
				},
			}),
		);
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
		setPlayerMuted,
		subscribeBuffering,
		logLevel,
		muted,
	]);

	useEffect(() => {
		return Effect.runCallback(
			Effect.gen(function* () {
				const now = Number(yield* Clock.monotonicTimeNanos) / 1_000_000;
				const remaining = 250 - (now - lastTimeUpdateTimestamp.current);
				if (remaining > 0) yield* Effect.sleep(remaining);
				emitter.dispatchTimeUpdate({frame});
				lastTimeUpdateTimestamp.current =
					Number(yield* Clock.monotonicTimeNanos) / 1_000_000;
			}),
		);
	}, [emitter, frame]);

	useEffect(() => {
		emitter.dispatchFrameUpdate({frame});
	}, [emitter, frame]);
};

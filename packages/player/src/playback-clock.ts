import {Cause, Clock, Effect, PubSub} from 'effect';
import type {ContextType} from 'react';
import type {Internals} from 'remotion';
import {calculateNextFrame} from './calculate-next-frame.js';

type PlaybackClockOptions = {
	fps: number;
	firstFrame: number;
	lastFrame: number;
	playbackRate: number;
	loop: boolean;
	moveToBeginningWhenEnded: boolean;
	muted: boolean;
	audio: ContextType<typeof Internals.SharedAudioContext>;
	getCurrentFrame: () => number;
	isPlaying: () => boolean;
	isBuffering: () => boolean;
	subscribeBuffering: (
		callback: (state: {buffering: boolean}) => void,
	) => () => void;
	setFrame: (frame: number) => void;
	setMuted: () => void;
	onEnded: () => void;
};

const nextPaint = Effect.callback<void>((resume) => {
	const id = requestAnimationFrame(() => resume(Effect.void));
	return Effect.sync(() => cancelAnimationFrame(id));
});

export const playbackClock = Effect.fnUntraced(
	function* (options: PlaybackClockOptions) {
		const changes = yield* Effect.acquireRelease(
			PubSub.sliding<void>(1),
			PubSub.shutdown,
		);
		const subscription = yield* PubSub.subscribe(changes);
		const changed = () => {
			PubSub.publishUnsafe(changes, undefined);
		};

		yield* Effect.acquireRelease(
			Effect.sync(() => {
				document.addEventListener('visibilitychange', changed);
				return options.subscribeBuffering(changed);
			}),
			(unsubscribe) =>
				Effect.sync(() => {
					unsubscribe();
					document.removeEventListener('visibilitychange', changed);
				}),
		);
		let started = yield* Clock.monotonicTimeNanos;
		let framesAdvanced = 0;
		let audioFailed = false;
		while (options.isPlaying()) {
			const resuming =
				options.muted || audioFailed
					? null
					: options.audio?.getIsResumingAudioContext();
			if (resuming) {
				const result = yield* Effect.promise(() => resuming);
				if (result === 'failed') {
					audioFailed = true;
					options.audio?.suspend();
					options.setMuted();
				}

				started = yield* Clock.monotonicTimeNanos;
				framesAdvanced = 0;
				continue;
			}

			if (options.isBuffering()) {
				if (!options.muted && !audioFailed) {
					options.audio?.suspend();
				}

				while (options.isBuffering()) {
					yield* PubSub.take(subscription);
				}

				if (
					!options.muted &&
					!audioFailed &&
					options.audio?._experimentalKeepAudioContextAlive
				) {
					options.audio.resume();
				}

				started = yield* Clock.monotonicTimeNanos;
				framesAdvanced = 0;
				continue;
			}

			yield* Effect.raceFirst(
				document.hidden ? Effect.sleep(1000 / options.fps) : nextPaint,
				PubSub.take(subscription),
			);
			if (!options.isPlaying()) {
				options.audio?.suspend();
				return;
			}

			if (options.isBuffering()) {
				continue;
			}

			if (!options.muted && !audioFailed) {
				options.audio?.resume();
			}

			const now = yield* Clock.monotonicTimeNanos;
			const {nextFrame, framesToAdvance, hasEnded} = calculateNextFrame({
				time: Number(now - started) / 1_000_000,
				currentFrame: options.getCurrentFrame(),
				playbackSpeed: options.playbackRate,
				fps: options.fps,
				actualFirstFrame: options.firstFrame,
				actualLastFrame: options.lastFrame,
				framesAdvanced,
				shouldLoop: options.loop,
			});
			framesAdvanced += framesToAdvance;
			if (
				nextFrame !== options.getCurrentFrame() &&
				(!hasEnded || options.moveToBeginningWhenEnded)
			) {
				options.setFrame(nextFrame);
			}

			if (hasEnded) {
				options.onEnded();
				return;
			}
		}
	},
	Effect.scoped,
	Effect.tapCauseIf(Cause.hasDies, Effect.logError),
);

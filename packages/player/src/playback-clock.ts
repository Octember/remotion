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

export const playbackClock = Effect.fnUntraced(
	function* (options: PlaybackClockOptions) {
		const changes = yield* Effect.acquireRelease(
			PubSub.sliding<void>(1),
			PubSub.shutdown,
		);
		const nextTick = PubSub.take(yield* PubSub.subscribe(changes));
		const changed = () => PubSub.publishUnsafe(changes, undefined);

		let paint: number;

		yield* Effect.acquireRelease(
			Effect.sync(() => {
				document.addEventListener('visibilitychange', changed);
				return options.subscribeBuffering(changed);
			}),
			(unsubscribe) =>
				Effect.sync(() => {
					unsubscribe();
					document.removeEventListener('visibilitychange', changed);
					cancelAnimationFrame(paint);
				}),
		);
		const clock = yield* Clock.Clock;
		let started = clock.monotonicTimeNanosUnsafe();
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

				started = clock.monotonicTimeNanosUnsafe();
				framesAdvanced = 0;
				continue;
			}

			if (options.isBuffering()) {
				if (!options.muted && !audioFailed) {
					options.audio?.suspend();
				}

				while (options.isBuffering()) {
					yield* nextTick;
				}

				if (
					!options.muted &&
					!audioFailed &&
					options.audio?._experimentalKeepAudioContextAlive
				) {
					options.audio.resume();
				}

				started = clock.monotonicTimeNanosUnsafe();
				framesAdvanced = 0;
				continue;
			}

			if (document.hidden) {
				yield* Effect.raceFirst(Effect.sleep(1000 / options.fps), nextTick);
			} else {
				paint = requestAnimationFrame(changed);
				yield* nextTick;
				cancelAnimationFrame(paint);
			}

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

			const now = clock.monotonicTimeNanosUnsafe();
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

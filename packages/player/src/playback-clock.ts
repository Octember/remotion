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
			PubSub.unbounded<Effect.Effect<void>>(),
			PubSub.shutdown,
		);
		const nextTick = Effect.flatten(
			PubSub.take(yield* PubSub.subscribe(changes)),
		);
		const changed = () => {
			// Finish native callbacks before control signals can close their scope.
			queueMicrotask(() => PubSub.publishUnsafe(changes, Effect.void));
		};

		let paint: number | null = null;
		const clock = yield* Clock.Clock;
		let started = clock.monotonicTimeNanosUnsafe();
		let framesAdvanced = 0;
		let audioFailed = false;
		let ended = false;
		const advance = () => {
			if (!options.isPlaying()) {
				options.audio?.suspend();
				return;
			}

			if (options.isBuffering()) {
				return;
			}

			if (!options.muted && !audioFailed) {
				options.audio?.resume();
			}

			const now = clock.monotonicTimeNanosUnsafe();
			const currentFrame = options.getCurrentFrame();
			const {nextFrame, framesToAdvance, hasEnded} = calculateNextFrame({
				time: Number(now - started) / 1_000_000,
				currentFrame,
				playbackSpeed: options.playbackRate,
				fps: options.fps,
				actualFirstFrame: options.firstFrame,
				actualLastFrame: options.lastFrame,
				framesAdvanced,
				shouldLoop: options.loop,
			});
			framesAdvanced += framesToAdvance;
			if (
				nextFrame !== currentFrame &&
				(!hasEnded || options.moveToBeginningWhenEnded)
			) {
				options.setFrame(nextFrame);
			}

			if (hasEnded) {
				ended = true;
				options.onEnded();
			}
		};

		const painted = () => {
			try {
				paint = requestAnimationFrame(painted);
				advance();
				if (
					ended ||
					!options.isPlaying() ||
					options.isBuffering() ||
					document.hidden ||
					(!options.muted &&
						!audioFailed &&
						options.audio?.getIsResumingAudioContext())
				) {
					changed();
				}
			} catch (error) {
				PubSub.publishUnsafe(changes, Effect.die(error));
			}
		};

		yield* Effect.acquireRelease(
			Effect.sync(() => {
				const unsubscribe = options.subscribeBuffering(changed);
				document.addEventListener('visibilitychange', changed);
				return unsubscribe;
			}),
			(unsubscribe) =>
				Effect.sync(() => {
					unsubscribe();
					document.removeEventListener('visibilitychange', changed);
					if (paint !== null) {
						cancelAnimationFrame(paint);
					}
				}),
		);
		while (options.isPlaying()) {
			if (ended) {
				return;
			}

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
				advance();
			} else {
				paint = requestAnimationFrame(painted);
				yield* nextTick;
				if (paint !== null) {
					cancelAnimationFrame(paint);
					paint = null;
				}

				if (!ended) {
					advance();
				}
			}
		}
	},
	Effect.scoped,
	Effect.tapCauseIf(Cause.hasDies, Effect.logError),
);

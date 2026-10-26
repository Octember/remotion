import {Clock, Effect, PubSub, Stream} from 'effect';
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
	audio: React.ContextType<typeof Internals.SharedAudioContext>;
	getCurrentFrame: () => number;
	isPlaying: () => boolean;
	isBuffering: () => boolean;
	subscribeBuffering: (
		listener: (state: {buffering: boolean}) => void,
	) => () => void;
	setFrame: (frame: number) => void;
	setMuted: () => void;
	onEnded: () => void;
};

const nextPaint = Effect.callback<void>((resume) => {
	const id = requestAnimationFrame(() => resume(Effect.void));
	return Effect.sync(() => cancelAnimationFrame(id));
});

export const playbackClock = (options: PlaybackClockOptions) =>
	Effect.scoped(
		Effect.gen(function* () {
			const buffering = yield* Effect.acquireRelease(
				PubSub.unbounded<boolean>(),
				PubSub.shutdown,
			);
			const visibility = yield* Effect.acquireRelease(
				PubSub.sliding<void>(1),
				PubSub.shutdown,
			);
			const subscription = yield* PubSub.subscribe(buffering);
			let audioFailed = false;
			const changed = () =>
				Effect.runSync(PubSub.publish(visibility, undefined));
			yield* Effect.acquireRelease(
				Effect.sync(() => {
					document.addEventListener('visibilitychange', changed);
					return options.subscribeBuffering((state) =>
						PubSub.publishUnsafe(buffering, state.buffering),
					);
				}),
				(unsubscribe) =>
					Effect.sync(() => {
						unsubscribe();
						document.removeEventListener('visibilitychange', changed);
					}),
			);
			const play = Effect.scoped(
				Effect.gen(function* () {
					if (!options.isPlaying()) return;
					if (!options.muted && !audioFailed) {
						options.audio?.resume();
						const resuming = options.audio?.getIsResumingAudioContext();
						if (
							resuming &&
							(yield* Effect.promise(() => resuming)) === 'failed'
						) {
							audioFailed = true;
							options.audio?.suspend();
							options.setMuted();
						}
					}

					const started = yield* Clock.monotonicTimeNanos;
					const visible = yield* PubSub.subscribe(visibility);
					let framesAdvanced = 0;
					while (options.isPlaying()) {
						yield* Effect.raceFirst(
							document.hidden ? Effect.sleep(1000 / options.fps) : nextPaint,
							PubSub.take(visible),
						);
						if (!options.isPlaying() || options.isBuffering()) continue;
						const now = yield* Clock.monotonicTimeNanos;
						const result = calculateNextFrame({
							time: Number(now - started) / 1_000_000,
							currentFrame: options.getCurrentFrame(),
							playbackSpeed: options.playbackRate,
							fps: options.fps,
							actualFirstFrame: options.firstFrame,
							actualLastFrame: options.lastFrame,
							framesAdvanced,
							shouldLoop: options.loop,
						});
						framesAdvanced += result.framesToAdvance;
						if (
							result.nextFrame !== options.getCurrentFrame() &&
							(!result.hasEnded || options.moveToBeginningWhenEnded)
						) {
							options.setFrame(result.nextFrame);
						}

						if (result.hasEnded) {
							options.onEnded();
							return;
						}
					}
				}),
			);
			yield* Stream.make(options.isBuffering()).pipe(
				Stream.concat(Stream.fromEffectRepeat(PubSub.take(subscription))),
				Stream.changes,
				Stream.switchMap((isBuffering) =>
					Stream.fromEffectDrain(
						isBuffering
							? Effect.sync(() => {
									if (!options.muted && !audioFailed) options.audio?.suspend();
								})
							: play,
					),
				),
				Stream.runDrain,
			);
		}),
	);

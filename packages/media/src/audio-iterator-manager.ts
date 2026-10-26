import {Cause, Effect, Exit, Fiber, PubSub, Scope} from 'effect';
import {
	AudioBufferSink,
	InputDisposedError,
	type InputAudioTrack,
} from 'mediabunny';
import type {LogLevel} from 'remotion';
import {Internals, type ScheduleAudioNodeResult} from 'remotion';
import {
	ALLOWED_GLOBAL_TIME_ANCHOR_SHIFT,
	isAlreadyQueued,
	makeAudioIterator,
	type AudioIterator,
	type QueuedPeriod,
} from './audio/audio-preview-iterator';
import {
	acquireAudioScheduler,
	StaleAudioRequestError,
} from './audio/audio-scheduler';
import {getScheduledTime} from './audio/get-scheduled-time';
import {pitchShiftAudioIterator} from './audio/pitch-shift';
import type {DelayPlaybackIfNotPremounting} from './delay-playback-if-not-premounting';
import {
	makeIteratorWithPriming,
	makeLoopingIterator,
	type AudioBufferSlice,
} from './make-iterator-with-priming';
import type {Nonce} from './nonce-manager';
import type {SharedAudioContextForMediaPlayer} from './shared-audio-context-for-media-player';

type ScheduleAudioNode = (
	node: AudioBufferSourceNode,
	mediaTimestamp: number,
	originalUnloopedMediaTimestamp: number,
	sourceOffsetInSeconds: number,
	sourceDurationInSeconds: number,
) => ScheduleAudioNodeResult;

export const MINIMUM_AUDIO_BUFFERING_TIME_SECONDS = 0.1;

export const hasEnoughAudioToStartPlayback = (bufferedDuration: number) => {
	return bufferedDuration >= MINIMUM_AUDIO_BUFFERING_TIME_SECONDS;
};

export type AudioIteratorAnchor = {
	// The unlooped time in seconds at which the current iterator was started
	unloopedStartInSeconds: number;
	// The media timestamp emitted by the current iterator at that unlooped time
	mediaStartInSeconds: number;
};

// Convert an unlooped composition time into the iterator's continuous media
// timeline using the anchor established when the iterator was started. The
// looping iterator emits timestamps that continue monotonically across loop
// iterations, so both the scheduler (getTargetTime) and the seek dedup must
// map times into this same frame via the identical formula.
export const anchorToContinuousTime = ({
	anchor,
	unloopedTimeInSeconds,
	playbackRate,
}: {
	anchor: AudioIteratorAnchor;
	unloopedTimeInSeconds: number;
	playbackRate: number;
}): number => {
	return (
		anchor.mediaStartInSeconds +
		(unloopedTimeInSeconds - anchor.unloopedStartInSeconds) * playbackRate
	);
};

export const audioIteratorManager = ({
	audioTrack,
	delayPlaybackHandleIfNotPremounting,
	sharedAudioContext,
	getSequenceEndTimestamp,
	getSequenceDurationInSeconds,
	getMediaEndTimestamp,
	getStartTime,
	initialMuted,
	initialVolume,
	toneFrequency,
	drawDebugOverlay,
}: {
	audioTrack: InputAudioTrack;
	delayPlaybackHandleIfNotPremounting: () => DelayPlaybackIfNotPremounting;
	sharedAudioContext: SharedAudioContextForMediaPlayer;
	getSequenceEndTimestamp: () => number;
	getSequenceDurationInSeconds: () => number;
	getMediaEndTimestamp: () => number;
	getStartTime: () => number;
	initialMuted: boolean;
	initialVolume: number;
	toneFrequency: number;
	drawDebugOverlay: () => void;
}) => {
	let muted = initialMuted;
	let currentVolume = Math.max(0, initialVolume);
	let currentToneFrequency = toneFrequency;
	const scope = Scope.makeUnsafe();
	const scheduler = acquireAudioScheduler(sharedAudioContext.audioContext);
	const scheduledNodes = Effect.runSync(PubSub.unbounded<void>());
	let currentSeek: {
		time: number;
		playbackRate: number;
		trimBefore: number | undefined;
		trimAfter: number | undefined;
		sequenceOffset: number;
		sequenceDurationInFrames: number;
		loop: boolean;
		fps: number;
	} | null = null;

	const gainNode = sharedAudioContext.audioContext.createGain();
	gainNode.gain.value = muted ? 0 : currentVolume;
	gainNode.connect(sharedAudioContext.gainNode);
	Effect.runSync(
		Scope.addFinalizer(
			scope,
			Effect.sync(() => {
				scheduler.release();
				gainNode.disconnect();
			}),
		),
	);
	Effect.runSync(Scope.addFinalizer(scope, PubSub.shutdown(scheduledNodes)));

	const audioSink = new AudioBufferSink(audioTrack);
	let audioBufferIterator: AudioIterator | null = null;
	// When looping, the iterator emits timestamps that continue monotonically
	// across loop iterations instead of wrapping. This anchor maps the unlooped
	// time to that continuous timeline so the scheduler can align chunks.
	let currentAnchor: AudioIteratorAnchor | null = null;
	let audioIteratorsCreated = 0;
	let totalAudioScheduledInSeconds = 0;
	let currentDelayHandle: {unblock: () => void} | null = null;

	const unblockCurrentDelayHandle = () => {
		if (currentDelayHandle) {
			currentDelayHandle.unblock();
			currentDelayHandle = null;
		}
	};

	const waitForNScheduledNodes = (n: number) =>
		Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const events = yield* PubSub.subscribe(scheduledNodes);
					for (let i = 0; i < n; i++) {
						yield* PubSub.take(events);
					}
				}),
			).pipe(
				Effect.forkIn(scope, {startImmediately: true}),
				Effect.flatMap(Fiber.join),
			),
		);

	const scheduleAudioChunk = ({
		buffer,
		mediaTimestamp,
		originalUnloopedMediaTimestamp,
		sourceOffsetInSeconds,
		sourceDurationInSeconds,
		playbackRate,
		scheduleAudioNode,
		logLevel,
	}: {
		buffer: AudioBuffer;
		mediaTimestamp: number;
		playbackRate: number;
		scheduleAudioNode: ScheduleAudioNode;
		logLevel: LogLevel;
		originalUnloopedMediaTimestamp: number;
		sourceOffsetInSeconds: number;
		sourceDurationInSeconds: number;
	}) => {
		if (!audioBufferIterator) {
			throw new Error('Audio buffer iterator not found');
		}

		if (muted) {
			return;
		}

		const node = sharedAudioContext.audioContext.createBufferSource();
		node.buffer = buffer;
		node.playbackRate.value = playbackRate;
		node.connect(gainNode);

		let started: ScheduleAudioNodeResult;
		try {
			started = scheduleAudioNode(
				node,
				mediaTimestamp,
				originalUnloopedMediaTimestamp,
				sourceOffsetInSeconds,
				sourceDurationInSeconds,
			);
		} catch (error) {
			node.disconnect();
			throw error;
		}

		if (started.type === 'not-started') {
			Internals.Log.verbose(
				{logLevel, tag: 'audio-scheduling'},
				'not started, disconnected: %s %s',
				mediaTimestamp.toFixed(3),
				buffer.duration.toFixed(3),
			);

			node.disconnect();
			return;
		}

		audioBufferIterator.addQueuedAudioNode({
			node,
			timestamp: mediaTimestamp,
			buffer,
			sourceDurationInSeconds,
			scheduledTime: started.scheduledTime,
			playbackRate,
			scheduledAtAnchor: sharedAudioContext.audioSyncAnchor.value,
		});
	};

	const onAudioChunk = ({
		buffer,
		playbackRate,
		scheduleAudioNode,
		logLevel,
	}: {
		buffer: AudioBufferSlice;
		playbackRate: number;
		scheduleAudioNode: ScheduleAudioNode;
		logLevel: LogLevel;
	}) => {
		if (muted) {
			return;
		}

		const startTime = getStartTime();
		const sequenceEndTime = getSequenceEndTimestamp();

		// Skip chunks entirely outside the range
		if (
			buffer.timelineTimestamp + buffer.sourceDurationInSeconds <=
			startTime
		) {
			return;
		}

		if (buffer.timelineTimestamp >= sequenceEndTime) {
			return;
		}

		const scheduledStart = Math.max(buffer.timelineTimestamp, startTime);
		const scheduledEnd = Math.min(
			buffer.timelineTimestamp + buffer.sourceDurationInSeconds,
			sequenceEndTime,
		);
		totalAudioScheduledInSeconds += Math.max(0, scheduledEnd - scheduledStart);

		scheduleAudioChunk({
			buffer: buffer.buffer.buffer,
			mediaTimestamp: buffer.timelineTimestamp,
			playbackRate,
			scheduleAudioNode,
			logLevel,
			originalUnloopedMediaTimestamp: buffer.buffer.timestamp,
			sourceOffsetInSeconds: buffer.sourceOffsetInSeconds,
			sourceDurationInSeconds: buffer.sourceDurationInSeconds,
		});

		drawDebugOverlay();
	};

	const startAudioIterator = ({
		playbackRate,
		startFromSecond,
		unloopedStartFromSecond,
		scheduleAudioNode,
		getTargetTime,
		logLevel,
		loop,
		unscheduleAudioNode,
		getAudioContextCurrentTimeMockedInTest,
	}: {
		startFromSecond: number;
		unloopedStartFromSecond: number;
		playbackRate: number;
		scheduleAudioNode: ScheduleAudioNode;
		getTargetTime: (
			mediaTimestamp: number,
			currentTime: number,
		) => number | null;
		logLevel: LogLevel;
		loop: boolean;
		unscheduleAudioNode: (node: AudioBufferSourceNode) => void;
		getAudioContextCurrentTimeMockedInTest: () => number;
	}) => {
		if (muted || scope.state._tag === 'Closed') {
			return;
		}

		const maximumTimestamp = getMediaEndTimestamp();
		if (startFromSecond >= maximumTimestamp) {
			return;
		}

		audioBufferIterator?.destroy();
		unblockCurrentDelayHandle();

		const delayHandle = delayPlaybackHandleIfNotPremounting();
		currentDelayHandle = delayHandle;

		currentAnchor = {
			unloopedStartInSeconds: unloopedStartFromSecond,
			mediaStartInSeconds: startFromSecond,
		};

		const maximumContinuousTimestamp =
			startFromSecond + getSequenceDurationInSeconds() * playbackRate;
		const unshiftedSource = loop
			? makeLoopingIterator({
					audioSink,
					seekTimeInSeconds: startFromSecond,
					loopStartInSeconds: getStartTime(),
					segmentEndInSeconds: maximumTimestamp,
					maximumContinuousTimestamp,
				})
			: makeIteratorWithPriming({
					audioSink,
					timeToSeek: startFromSecond,
					maximumTimestamp,
				});
		const source = pitchShiftAudioIterator({
			iterator: unshiftedSource,
			toneFrequency: currentToneFrequency,
		});
		const iterator = makeAudioIterator({
			startFromSecond,
			iterator: source,
			unscheduleAudioNode,
		});
		audioIteratorsCreated++;
		audioBufferIterator = iterator;

		let bufferedUntil = startFromSecond;
		const unblockPlayback = () => {
			if (currentDelayHandle === delayHandle) {
				currentDelayHandle = null;
				delayHandle.unblock();
			}
		};

		const {currentTime} = sharedAudioContext.audioContext;
		const getPriority = () => {
			const mediaTimestamp = iterator.guessNextTimestamp();
			const targetTime = getTargetTime(mediaTimestamp, currentTime);
			return targetTime === null
				? null
				: getScheduledTime({
						mediaTimestamp,
						targetTime,
						currentTime,
						sequenceStartTime: getStartTime(),
					}) - getAudioContextCurrentTimeMockedInTest();
		};

		Effect.runSync(
			Effect.forkIn(
				Effect.gen(function* () {
					while (true) {
						const result = yield* scheduler.run(
							getPriority,
							Effect.tryPromise({
								try: () => iterator.getNextFn(),
								catch: (error) => error,
							}),
						);
						if (!result.value) {
							return;
						}

						bufferedUntil = Math.max(
							bufferedUntil,
							result.value.timelineTimestamp +
								result.value.sourceDurationInSeconds,
						);
						if (
							hasEnoughAudioToStartPlayback(bufferedUntil - startFromSecond)
						) {
							unblockPlayback();
						}

						PubSub.publishUnsafe(scheduledNodes, undefined);
						onAudioChunk({
							buffer: result.value,
							playbackRate,
							scheduleAudioNode,
							logLevel,
						});
					}
				}).pipe(
					Effect.catchCause((cause) =>
						Effect.uninterruptible(
							Effect.gen(function* () {
								yield* Effect.sync(() => {
									if (
										!Cause.hasInterruptsOnly(cause) &&
										audioBufferIterator === iterator
									) {
										currentSeek = null;
									}

									iterator.destroy();
								});
								const error = Cause.squash(cause);
								if (
									Cause.hasInterruptsOnly(cause) ||
									error instanceof InputDisposedError ||
									error instanceof StaleAudioRequestError
								) {
									return;
								}

								Internals.Log.error(
									{logLevel, tag: 'audio-scheduling'},
									'Audio scheduling failed',
									error,
								);
								return yield* Effect.failCause(cause);
							}),
						),
					),
					Effect.ensuring(Effect.sync(unblockPlayback)),
				),
				iterator.scope,
			),
		);
	};

	const seek = ({
		newTime,
		unloopedNewTime,
		nonce,
		playbackRate,
		localPlaybackRate,
		scheduleAudioNode,
		getTargetTime,
		logLevel,
		loop,
		trimBefore,
		trimAfter,
		sequenceOffset,
		sequenceDurationInFrames,
		fps,
		getAudioContextCurrentTimeMockedInTest,
	}: {
		newTime: number;
		unloopedNewTime: number;
		nonce: Nonce;
		playbackRate: number;
		localPlaybackRate: number;
		scheduleAudioNode: ScheduleAudioNode;
		getTargetTime: (
			mediaTimestamp: number,
			currentTime: number,
		) => number | null;
		logLevel: LogLevel;
		loop: boolean;
		trimBefore: number | undefined;
		trimAfter: number | undefined;
		sequenceOffset: number;
		sequenceDurationInFrames: number;
		fps: number;
		getAudioContextCurrentTimeMockedInTest: () => number;
	}) => {
		if (nonce.isStale()) {
			return;
		}

		if (
			currentSeek !== null &&
			currentSeek.time === newTime &&
			currentSeek.playbackRate === playbackRate &&
			currentSeek.trimBefore === trimBefore &&
			currentSeek.trimAfter === trimAfter &&
			currentSeek.sequenceOffset === sequenceOffset &&
			currentSeek.sequenceDurationInFrames === sequenceDurationInFrames &&
			currentSeek.loop === loop &&
			currentSeek.fps === fps
		) {
			return;
		}

		currentSeek = {
			time: newTime,
			playbackRate,
			trimBefore,
			trimAfter,
			sequenceOffset,
			sequenceDurationInFrames,
			loop,
			fps,
		};

		if (muted) {
			return;
		}

		if (audioBufferIterator && !audioBufferIterator.isDestroyed()) {
			// When looping, queued nodes carry continuous timestamps that don't
			// wrap at loop boundaries. Map the new time into that continuous
			// frame so it can be compared against the queued period.
			const timeToCheck =
				loop && currentAnchor
					? anchorToContinuousTime({
							anchor: currentAnchor,
							unloopedTimeInSeconds: unloopedNewTime,
							playbackRate: localPlaybackRate,
						})
					: newTime;
			const queuedPeriod = audioBufferIterator.getQueuedPeriod();
			// If there is a missing period, but we'd have no chance to schedule nodes,
			// then let's not bother. Let's just leave the gap.
			const queuedPeriodMinusLatency: QueuedPeriod | null = queuedPeriod
				? {
						from:
							queuedPeriod.from -
							ALLOWED_GLOBAL_TIME_ANCHOR_SHIFT -
							sharedAudioContext.audioContext.baseLatency -
							sharedAudioContext.audioContext.outputLatency,
						until: queuedPeriod.until,
					}
				: null;
			const currentTimeIsAlreadyQueued = isAlreadyQueued(
				timeToCheck,
				queuedPeriodMinusLatency,
			);
			if (currentTimeIsAlreadyQueued) {
				scheduler.wake();
				// current time is scheduled, will keep scheduling
				return;
			}

			const currentIteratorTimestamp = audioBufferIterator.guessNextTimestamp();
			const iteratorHasAdvancedThroughSilence =
				loop &&
				currentAnchor !== null &&
				unloopedNewTime >= currentAnchor.unloopedStartInSeconds &&
				currentIteratorTimestamp >= timeToCheck;
			if (
				iteratorHasAdvancedThroughSilence ||
				(currentIteratorTimestamp < timeToCheck &&
					Math.abs(currentIteratorTimestamp - timeToCheck) < 1)
			) {
				scheduler.wake();
				// The iterator has either advanced beyond the current time, meaning
				// the gap is known silence, or is less than 1 second behind. Let it run.
				return;
			}
		}

		startAudioIterator({
			playbackRate,
			startFromSecond: newTime,
			unloopedStartFromSecond: unloopedNewTime,
			scheduleAudioNode,
			getTargetTime,
			logLevel,
			loop,
			unscheduleAudioNode: sharedAudioContext.unscheduleAudioNode,
			getAudioContextCurrentTimeMockedInTest,
		});

		// Not further scheduling, initial iterator is already running
	};

	return {
		startAudioIterator,
		wakeScheduler: scheduler.wake,
		dispose: () => {
			audioBufferIterator?.destroy();
			unblockCurrentDelayHandle();
			Effect.runFork(Scope.close(scope, Exit.void));
		},
		getAudioBufferIterator: () => audioBufferIterator,
		getCurrentAnchor: () => currentAnchor,
		destroyIterator: () => {
			audioBufferIterator?.destroy();
			audioBufferIterator = null;
			// Drop the anchor together with the iterator it described, so
			// getCurrentAnchor() cannot hand out a stale mapping (from a previous
			// rate/trim) during the window before a new iterator is started.
			currentAnchor = null;
			currentSeek = null;
			unblockCurrentDelayHandle();
		},
		seek,
		getAudioIteratorsCreated: () => audioIteratorsCreated,
		getTotalAudioScheduledInSeconds: () => totalAudioScheduledInSeconds,
		setMuted: (newMuted: boolean) => {
			muted = newMuted;
			gainNode.gain.value = muted ? 0 : currentVolume;
		},
		setVolume: (volume: number) => {
			currentVolume = Math.max(0, volume);
			gainNode.gain.value = muted ? 0 : currentVolume;
		},
		setToneFrequency: (newToneFrequency: number) => {
			currentToneFrequency = newToneFrequency;
		},
		scheduleAudioChunk,
		waitForNScheduledNodes,
	};
};

export type AudioIteratorManager = ReturnType<typeof audioIteratorManager>;

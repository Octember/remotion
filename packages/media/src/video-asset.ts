import type {InputVideoTrack} from 'mediabunny';
import {CanvasSink} from 'mediabunny';
import {roundTo4Digits} from './helpers/round-to-4-digits';
import type {MediaPresentation} from './media-presentation';
import type {Nonce} from './nonce-manager';
import {makePrewarmedVideoIteratorCache} from './prewarm-iterator-for-looping';
import {
	createVideoIterator,
	type VideoIterator,
} from './video/video-preview-iterator';

export const isSequentialMediaTimeAdvance = ({
	previousTime,
	newTime,
	fps,
	playbackRate,
	isPlaying,
}: {
	previousTime: number;
	newTime: number;
	fps: number;
	playbackRate: number;
	isPlaying: boolean;
}) => {
	if (!isPlaying || newTime < previousTime) {
		return false;
	}

	const maximumSequentialAdvance = Math.abs(playbackRate) / fps;
	return (
		roundTo4Digits(newTime - previousTime) <=
		roundTo4Digits(maximumSequentialAdvance)
	);
};

export const videoAsset = ({
	presentation,
	videoTrack,
	getLoopSegmentMediaEndTimestamp,
	getStartTime,
	getIsLooping,
}: {
	videoTrack: InputVideoTrack;
	presentation: MediaPresentation;
	getLoopSegmentMediaEndTimestamp: () => number;
	getStartTime: () => number;
	getIsLooping: () => boolean;
}) => {
	let videoIteratorsCreated = 0;
	let videoFrameIterator: VideoIterator | null = null;
	let currentSeek: number | null = null;

	const canvasSink = new CanvasSink(videoTrack, {
		// Match the preview look-ahead buffer size. CanvasSink may reuse pooled
		// canvas objects for later decoded frames, so Remotion copies pixels into
		// stable canvases before retaining frames across seeks/peeks.
		poolSize: 3,
		fit: 'contain',
		alpha: true,
	});

	const prewarmedVideoIteratorCache =
		makePrewarmedVideoIteratorCache(canvasSink);

	const startVideoIterator = async (
		timeToSeek: number,
		nonce: Nonce,
	): Promise<void> => {
		presentation.clearCurrentFrame();
		videoFrameIterator?.destroy();
		using _ = presentation.createDelayPlaybackHandle();
		currentSeek = timeToSeek;

		const iterator = await createVideoIterator(
			timeToSeek,
			prewarmedVideoIteratorCache,
		);
		videoIteratorsCreated++;
		videoFrameIterator = iterator;

		if (iterator.isDestroyed()) {
			return;
		}

		if (nonce.isStale()) {
			// During a paused scrub, every seek goes stale before its decode
			// lands, so returning undrawn would discard every frame and freeze
			// the preview. Painting is safe: the newer seek always lands last.
			if (!videoFrameIterator.isDestroyed() && iterator.initialFrame) {
				await presentation.drawFrame(iterator.initialFrame);
			}

			return;
		}

		if (videoFrameIterator.isDestroyed()) {
			return;
		}

		if (!iterator.initialFrame) {
			// media ended
			return;
		}

		await presentation.drawFrame(iterator.initialFrame);
	};

	const seek = async ({
		newTime,
		nonce,
		fps,
		playbackRate,
		isPlaying,
	}: {
		newTime: number;
		nonce: Nonce;
		fps: number;
		playbackRate: number;
		isPlaying: boolean;
	}) => {
		if (!videoFrameIterator) {
			return;
		}

		if (
			currentSeek !== null &&
			roundTo4Digits(currentSeek) === roundTo4Digits(newTime)
		) {
			return;
		}

		const previousTime = currentSeek;
		currentSeek = newTime;

		if (getIsLooping()) {
			// If less than 1 second from the end away, we pre-warm a new iterator
			if (getLoopSegmentMediaEndTimestamp() - newTime < 1) {
				prewarmedVideoIteratorCache.prewarmIteratorForLooping({
					timeToSeek: getStartTime(),
				});
			}
		}

		const pendingFrameBehavior =
			previousTime !== null &&
			isSequentialMediaTimeAdvance({
				previousTime,
				newTime,
				fps,
				playbackRate,
				isPlaying,
			})
				? 'wait'
				: 'restart-iterator';
		const videoSatisfyResult = await videoFrameIterator.tryToSatisfySeek(
			newTime,
			{
				pendingFrameBehavior,
				shouldContinue: () => !nonce.isStale(),
			},
		);

		// Doing this before the staleness check, because
		// frame might be better than what we currently have
		// TODO: check if this is actually true
		if (videoSatisfyResult.type === 'satisfied') {
			await presentation.drawFrame(videoSatisfyResult.frame);
			return;
		}

		if (nonce.isStale()) {
			return;
		}

		await startVideoIterator(newTime, nonce);
	};

	return {
		startVideoIterator,
		getVideoIteratorsCreated: () => videoIteratorsCreated,
		seek,
		destroy: () => {
			presentation.clearCurrentFrame();
			prewarmedVideoIteratorCache.destroy();
			videoFrameIterator?.destroy();
			presentation.dispose();
			videoFrameIterator = null;
		},
		getVideoFrameIterator: () => videoFrameIterator,
	};
};

export type VideoAsset = ReturnType<typeof videoAsset>;

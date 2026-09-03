import {ALL_FORMATS, Input, UrlSource} from 'mediabunny';
import {expect, test} from 'vitest';
import {makeNonceManager} from '../nonce-manager';
import {isSequentialMediaTimeAdvance, videoAsset} from '../video-asset';

test('detects one timeline frame as a sequential media time advance', () => {
	expect(
		isSequentialMediaTimeAdvance({
			previousTime: 0,
			newTime: 1 / 30,
			fps: 30,
			playbackRate: 1,
			isPlaying: true,
		}),
	).toBe(true);

	expect(
		isSequentialMediaTimeAdvance({
			previousTime: 0,
			newTime: 2 / 30,
			fps: 30,
			playbackRate: 1,
			isPlaying: true,
		}),
	).toBe(false);
});

test('accounts for playback rate when detecting sequential advances', () => {
	expect(
		isSequentialMediaTimeAdvance({
			previousTime: 1,
			newTime: 1 + 2 / 30,
			fps: 30,
			playbackRate: 2,
			isPlaying: true,
		}),
	).toBe(true);

	expect(
		isSequentialMediaTimeAdvance({
			previousTime: 1,
			newTime: 0.9,
			fps: 30,
			playbackRate: 2,
			isPlaying: true,
		}),
	).toBe(false);
});

test('does not treat a paused forward scrub as sequential playback', () => {
	expect(
		isSequentialMediaTimeAdvance({
			previousTime: 1,
			newTime: 1.1,
			fps: 30,
			playbackRate: 4,
			isPlaying: false,
		}),
	).toBe(false);
});

const prepare = async () => {
	const input = new Input({
		source: new UrlSource('https://remotion.media/video.mp4'),
		formats: ALL_FORMATS,
	});
	const videoTrack = await input.getPrimaryVideoTrack();
	if (!videoTrack) {
		throw new Error('No video track found');
	}

	return {videoTrack};
};

const notLooping = {
	isLooping: false,
	loopSegmentMediaEndTimestamp: Infinity,
	loopStartTime: 0,
};

test('plays at a high playback rate without restarting the iterator', async () => {
	const {videoTrack} = await prepare();
	const asset = videoAsset({videoTrack});
	const nonceManager = makeNonceManager();

	try {
		await asset.startVideoIterator(0, nonceManager.createAsyncOperation());

		for (let frame = 1; frame <= 25; frame++) {
			await asset.seek({
				newTime: (frame * 3.75) / 30,
				nonce: nonceManager.createAsyncOperation(),
				fps: 30,
				playbackRate: 3.75,
				isPlaying: true,
				...notLooping,
			});
		}

		expect(asset.getVideoIteratorsCreated()).toBe(1);
	} finally {
		asset.destroy();
	}
});

test('paused forward scrubs do not wait for pending frames', async () => {
	const {videoTrack} = await prepare();
	const asset = videoAsset({videoTrack});
	const nonceManager = makeNonceManager();

	try {
		await asset.startVideoIterator(0, nonceManager.createAsyncOperation());
		const iterator = asset.getVideoFrameIterator();
		if (!iterator) {
			throw new Error('Expected a video iterator');
		}

		let pendingFrameBehavior: 'wait' | 'restart-iterator' | null = null;
		iterator.tryToSatisfySeek = (_time, options) => {
			pendingFrameBehavior = options.pendingFrameBehavior;
			return Promise.resolve({
				type: 'not-satisfied' as const,
				reason: 'test',
			});
		};

		await asset.seek({
			newTime: 0.1,
			nonce: nonceManager.createAsyncOperation(),
			fps: 30,
			playbackRate: 4,
			isPlaying: false,
			...notLooping,
		});

		expect(pendingFrameBehavior).toBe('restart-iterator');
	} finally {
		asset.destroy();
	}
});

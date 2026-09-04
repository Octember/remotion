import type {AnyIterable, InputVideoTrack, WrappedCanvas} from 'mediabunny';
import {CanvasSink} from 'mediabunny';
import {Internals, type LogLevel} from 'remotion';
import {canvasesAheadOfTime} from './canvas-ahead-of-time';
import type {RetainedVideoFrameBudget} from './retained-video-frame-budget';

let nextVideoAssetId = 0;

export const videoAsset = ({
	videoTrack,
	frameBudget,
	logLevel,
}: {
	videoTrack: InputVideoTrack;
	frameBudget: RetainedVideoFrameBudget;
	logLevel: LogLevel;
}) => {
	const assetId = ++nextVideoAssetId;
	const budgetKey = {};
	let retainedFrame: WrappedCanvas | null = null;
	const canvasSink = new CanvasSink(videoTrack, {
		poolSize: 3,
		fit: 'contain',
		alpha: true,
	});
	const clearRetainedFrame = () => {
		retainedFrame = null;
	};

	const log = (message: string) =>
		Internals.Log.trace(
			{logLevel, tag: '@remotion/media'},
			`[VideoAsset ${assetId}] ${message}`,
		);
	const copyFrame = (frame: WrappedCanvas) => {
		const canvas = new OffscreenCanvas(frame.canvas.width, frame.canvas.height);
		const context = canvas.getContext('2d');
		if (!context) {
			throw new Error('Could not create canvas context');
		}

		context.drawImage(frame.canvas, 0, 0);
		return {...frame, canvas};
	};

	return {
		getRetainedFrame: () => retainedFrame,
		publishFrame: (frame: WrappedCanvas) => {
			const copied = copyFrame(frame);
			const bytes = copied.canvas.width * copied.canvas.height * 4;
			retainedFrame = copied;
			const retained = frameBudget.retain({
				key: budgetKey,
				bytes,
				clear: clearRetainedFrame,
			});
			if (!retained) {
				retainedFrame = null;
			}

			const usage = frameBudget.getUsage();
			log(
				`published timestamp=${frame.timestamp.toFixed(3)}s retained=${retained} frames=${usage.frames} bytes=${usage.bytes}`,
			);
		},
		getCanvas: async (timestamp: number) => {
			const frame = await canvasSink.getCanvas(timestamp);
			if (!frame) {
				return null;
			}

			const canvas = new OffscreenCanvas(
				frame.canvas.width,
				frame.canvas.height,
			);
			const context = canvas.getContext('2d');
			if (!context) {
				throw new Error('Could not create canvas context');
			}

			context.drawImage(frame.canvas, 0, 0);
			return {...frame, canvas};
		},
		canvases: (startTimestamp?: number, endTimestamp?: number) =>
			canvasesAheadOfTime(canvasSink, startTimestamp, endTimestamp),
		canvasesAtTimestamps: (timestamps: AnyIterable<number>) =>
			canvasSink.canvasesAtTimestamps(timestamps),
		dispose: () => {
			frameBudget.release(budgetKey);
			clearRetainedFrame();
			log('disposed');
		},
	};
};

export type VideoAsset = ReturnType<typeof videoAsset>;

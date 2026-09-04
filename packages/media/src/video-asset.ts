import type {AnyIterable, InputVideoTrack} from 'mediabunny';
import {CanvasSink} from 'mediabunny';
import {canvasesAheadOfTime} from './canvas-ahead-of-time';

export const videoAsset = ({videoTrack}: {videoTrack: InputVideoTrack}) => {
	const canvasSink = new CanvasSink(videoTrack, {
		poolSize: 3,
		fit: 'contain',
		alpha: true,
	});
	return {
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
	};
};

export type VideoAsset = ReturnType<typeof videoAsset>;

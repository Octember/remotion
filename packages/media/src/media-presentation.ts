import type {InputVideoTrack, WrappedCanvas} from 'mediabunny';
import type {
	EffectChainState,
	EffectDefinitionAndStack,
	LogLevel,
} from 'remotion';
import {Internals} from 'remotion';
import type {DelayPlaybackIfNotPremounting} from './delay-playback-if-not-premounting';

const {runEffectChain} = Internals;

export const mediaPresentation = async ({
	videoTrack,
	delayPlaybackHandleIfNotPremounting,
	context,
	canvas,
	getOnVideoFrameCallback,
	logLevel,
	drawDebugOverlay,
	getEffects,
	getEffectChainState,
}: {
	videoTrack: InputVideoTrack;
	delayPlaybackHandleIfNotPremounting: () => DelayPlaybackIfNotPremounting;
	context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
	canvas: OffscreenCanvas | HTMLCanvasElement | null;
	getOnVideoFrameCallback: () => null | ((frame: CanvasImageSource) => void);
	logLevel: LogLevel;
	drawDebugOverlay: () => void;
	getEffects: () => EffectDefinitionAndStack<unknown>[];
	getEffectChainState: (
		width: number,
		height: number,
	) => EffectChainState | null;
}) => {
	let framesRendered = 0;
	let currentDelayHandle: DelayPlaybackIfNotPremounting | null = null;
	let lastDrawnFrame: WrappedCanvas | null = null;
	let disposed = false;

	if (canvas) {
		const displayWidth = await videoTrack.getDisplayWidth();
		const displayHeight = await videoTrack.getDisplayHeight();
		if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
			canvas.width = displayWidth;
			canvas.height = displayHeight;
		}
	}

	const paintFrame = async (frame: WrappedCanvas): Promise<void> => {
		if (disposed) {
			return;
		}

		if (context && canvas) {
			const effects = getEffects();
			const chainState = getEffectChainState(canvas.width, canvas.height);
			if (
				effects.length > 0 &&
				chainState &&
				canvas instanceof HTMLCanvasElement
			) {
				await runEffectChain({
					state: chainState,
					source: frame.canvas,
					effects,
					output: canvas,
					width: canvas.width,
					height: canvas.height,
				});
			} else {
				context.clearRect(0, 0, canvas.width, canvas.height);
				context.drawImage(frame.canvas, 0, 0);
			}
		}
	};

	const drawFrame = async (frame: WrappedCanvas): Promise<void> => {
		await paintFrame(frame);
		if (disposed) {
			return;
		}

		lastDrawnFrame = frame;
		framesRendered++;
		drawDebugOverlay();
		getOnVideoFrameCallback()?.(frame.canvas);

		Internals.Log.trace(
			{logLevel, tag: '@remotion/media'},
			`[MediaPlayer] Drew frame ${frame.timestamp.toFixed(3)}s`,
		);
	};

	return {
		createDelayPlaybackHandle: () => {
			const handle = delayPlaybackHandleIfNotPremounting();
			currentDelayHandle = handle;
			return handle;
		},
		drawFrame,
		redrawCurrentFrame: async (): Promise<void> => {
			if (disposed || !lastDrawnFrame) {
				return;
			}

			await paintFrame(lastDrawnFrame);
			if (disposed || !lastDrawnFrame) {
				return;
			}

			drawDebugOverlay();
			getOnVideoFrameCallback()?.(lastDrawnFrame.canvas);

			Internals.Log.trace(
				{logLevel, tag: '@remotion/media'},
				`[MediaPlayer] Redrew frame ${lastDrawnFrame.timestamp.toFixed(3)}s with updated effects`,
			);
		},
		clearCurrentFrame: () => {
			lastDrawnFrame = null;
		},
		dispose: () => {
			disposed = true;
			lastDrawnFrame = null;
			currentDelayHandle?.unblock();
			currentDelayHandle = null;
			if (context && canvas) {
				context.clearRect(0, 0, canvas.width, canvas.height);
			}
		},
		getFramesRendered: () => framesRendered,
	};
};

export type MediaPresentation = Awaited<ReturnType<typeof mediaPresentation>>;

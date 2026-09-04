import type {InputVideoTrack, WrappedCanvas} from 'mediabunny';
import type {
	EffectChainState,
	EffectDefinitionAndStack,
	LogLevel,
} from 'remotion';
import {Internals} from 'remotion';
import type {DelayPlaybackIfNotPremounting} from './delay-playback-if-not-premounting';
import {roundTo4Digits} from './helpers/round-to-4-digits';

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
	let lastDrawnFrameIsPlaceholder = false;
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
		lastDrawnFrameIsPlaceholder = false;
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
		hasCurrentFrame: () => lastDrawnFrame !== null,
		paintPlaceholder: async (
			frame: WrappedCanvas,
			targetTimestamp: number,
		): Promise<void> => {
			await paintFrame(frame);
			if (disposed) {
				return;
			}

			lastDrawnFrame = frame;
			lastDrawnFrameIsPlaceholder = true;
			drawDebugOverlay();
			const kind =
				roundTo4Digits(frame.timestamp) === roundTo4Digits(targetTimestamp)
					? 'exact'
					: 'placeholder';
			Internals.Log.trace(
				{logLevel, tag: '@remotion/media'},
				`[MediaPlayer] Retained paint kind=${kind} retained=${frame.timestamp.toFixed(3)}s target=${targetTimestamp.toFixed(3)}s delta=${Math.abs(frame.timestamp - targetTimestamp).toFixed(3)}s`,
			);
		},
		redrawCurrentFrame: async (): Promise<void> => {
			if (disposed || !lastDrawnFrame) {
				return;
			}

			await paintFrame(lastDrawnFrame);
			if (disposed || !lastDrawnFrame) {
				return;
			}

			drawDebugOverlay();
			if (!lastDrawnFrameIsPlaceholder) {
				getOnVideoFrameCallback()?.(lastDrawnFrame.canvas);
			}

			Internals.Log.trace(
				{logLevel, tag: '@remotion/media'},
				`[MediaPlayer] Redrew frame ${lastDrawnFrame.timestamp.toFixed(3)}s with updated effects`,
			);
		},
		dispose: () => {
			disposed = true;
			lastDrawnFrame = null;
			lastDrawnFrameIsPlaceholder = false;
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

import {Effect} from 'effect';

export type AudioContextResumeResult = 'resumed' | 'cancelled' | 'failed';

export const waitUntilActuallyResumed = (
	audioContext: AudioContext,
): Effect.Effect<'resumed'> =>
	Effect.callback<'resumed'>((resume) => {
		// Autoplay denial waits for another gesture instead of silently muting.
		const onStateChange = () => {
			if (audioContext.state === 'running') resume(Effect.succeed('resumed'));
		};

		audioContext.addEventListener('statechange', onStateChange);
		onStateChange();
		return Effect.sync(() =>
			audioContext.removeEventListener('statechange', onStateChange),
		);
	});

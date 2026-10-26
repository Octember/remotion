import {Effect, PubSub} from 'effect';
import {Log, type LogLevel} from '../log.js';

export const createAudioClock = () => {
	let value = 0;
	const changes = Effect.runSync(PubSub.sliding<number>(1));
	return {
		get value() {
			return value;
		},
		changes,
		synchronize: ({
			audioContext,
			absoluteTimeInSeconds,
			globalPlaybackRate,
			logLevel,
			force,
		}: {
			audioContext: AudioContext;
			absoluteTimeInSeconds: number;
			globalPlaybackRate: number;
			logLevel: LogLevel;
			force: boolean;
		}) => {
			const next =
				audioContext.currentTime - absoluteTimeInSeconds / globalPlaybackRate;
			const shift = next - value;
			const latency =
				audioContext.baseLatency +
				(audioContext.outputLatency === 0 ? 0.3 : audioContext.outputLatency);
			if (
				(!force && Math.abs(shift) < 0.1 + latency) ||
				Math.abs(shift) < Number.EPSILON
			)
				return;
			Log.verbose(
				{logLevel, tag: 'audio-scheduling'},
				'Anchor changed from %s to %s with shift %s',
				value,
				next,
				shift,
			);
			value = next;
			Effect.runSync(PubSub.publish(changes, value));
		},
	};
};

export type AudioClock = ReturnType<typeof createAudioClock>;

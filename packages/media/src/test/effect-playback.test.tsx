import {Player, type PlayerRef} from '@remotion/player';
import React, {useContext, useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {Internals, useBufferState} from 'remotion';
import {expect, test} from 'vitest';
import {Audio} from '../audio/audio';
import {Video} from '../video/video';
import {wait, waitFor} from './player-frame-accuracy-utils';

type Probe = {
	readonly analyser: AnalyserNode;
	readonly buffer: ReturnType<typeof useBufferState>;
};

type FixtureProps = {
	readonly from: number;
	readonly premountFor: number;
	readonly trimBefore: number;
	readonly trimAfter: number;
	readonly mediaPlaybackRate: number;
	readonly inspect: (probe: Probe | null) => void;
	readonly onVideoFrame: () => void;
};

const Composition: React.FC<FixtureProps> = ({
	from,
	premountFor,
	trimBefore,
	trimAfter,
	mediaPlaybackRate,
	inspect,
	onVideoFrame,
}) => {
	const audio = useContext(Internals.SharedAudioContext);
	const buffer = useBufferState();
	useEffect(() => {
		if (!audio?.audioContext || !audio.gainNode) return;
		const analyser = audio.audioContext.createAnalyser();
		audio.gainNode.connect(analyser);
		inspect({analyser, buffer});
		return () => {
			audio.gainNode!.disconnect(analyser);
			inspect(null);
		};
	}, [audio, buffer, inspect]);

	return (
		<>
			<Video
				data-testid="native-video"
				disallowFallbackToOffthreadVideo
				from={from}
				loop
				muted
				onVideoFrame={onVideoFrame}
				playbackRate={mediaPlaybackRate}
				premountFor={premountFor}
				src="/bigbuckbunny.mp4"
				trimAfter={trimAfter}
				trimBefore={trimBefore}
			/>
			<Audio
				disallowFallbackToHtml5Audio
				from={from}
				loop
				playbackRate={mediaPlaybackRate}
				premountFor={premountFor}
				src="/dialogue.wav"
				trimAfter={trimAfter}
				trimBefore={trimBefore}
			/>
		</>
	);
};

const mountPlayer = async ({
	from,
	durationInFrames,
	keepAudioContextAlive,
}: {
	readonly from: number;
	readonly durationInFrames: number;
	readonly keepAudioContextAlive: boolean;
}) => {
	const container = document.createElement('div');
	document.body.appendChild(container);
	const root = createRoot(container);
	const ref = React.createRef<PlayerRef>();
	let probe: Probe | null = null;
	let drawnFrames = 0;
	let props = {
		from,
		premountFor: from,
		trimBefore: 30,
		trimAfter: 90,
		mediaPlaybackRate: 1,
	};
	const inspect = (value: Probe | null) => {
		probe = value;
	};

	const onVideoFrame = () => {
		drawnFrames++;
	};

	const render = (playbackRate: number) =>
		root.render(
			<Player
				ref={ref}
				_experimentalKeepAudioContextAlive={keepAudioContextAlive}
				acknowledgeRemotionLicense
				component={Composition}
				compositionHeight={720}
				compositionWidth={1280}
				durationInFrames={durationInFrames}
				fps={30}
				inputProps={{...props, inspect, onVideoFrame}}
				loop
				playbackRate={playbackRate}
			/>,
		);
	render(1);
	await waitFor(
		() => ref.current !== null && probe !== null && drawnFrames > 0,
	);
	return {
		container,
		player: ref.current!,
		getProbe: () => probe!,
		getDrawnFrames: () => drawnFrames,
		peak: () => {
			const samples = new Float32Array(probe!.analyser.fftSize);
			probe!.analyser.getFloatTimeDomainData(samples);
			return samples.reduce(
				(maximum, sample) => Math.max(maximum, Math.abs(sample)),
				0,
			);
		},
		update: (playbackRate: number) => {
			props = {
				...props,
				trimBefore: 60,
				trimAfter: 105,
				mediaPlaybackRate: 1.5,
			};
			render(playbackRate);
		},
		unmount: () => {
			root.unmount();
			container.remove();
		},
	};
};

test('native audio and video survive pause, buffering, rapid seek, and rate/trim changes', async () => {
	const fixture = await mountPlayer({
		from: 0,
		durationInFrames: 300,
		keepAudioContextAlive: false,
	});
	const {player} = fixture;
	try {
		const clock = player.getAudioClock();
		expect(clock?.context).toBeInstanceOf(AudioContext);
		expect(clock?.fps).toBe(30);
		expect(clock?.playbackRate).toBe(1);
		player.play();
		await waitFor(
			() => clock!.context.state === 'running' && fixture.peak() > 0.001,
		);
		await waitFor(() => player.getCurrentFrame() >= 8);
		expect(fixture.getDrawnFrames()).toBeGreaterThan(2);
		expect(fixture.container.querySelector('video')).toBeNull();

		player.pause();
		await waitFor(() => clock!.context.state === 'suspended');
		const pausedFrame = player.getCurrentFrame();
		await wait(150);
		expect(player.getCurrentFrame()).toBe(pausedFrame);
		player.play();
		await waitFor(() => player.getCurrentFrame() > pausedFrame + 3);
		await waitFor(() => fixture.peak() > 0.001);

		let waiting = 0;
		let resumed = 0;
		player.addEventListener('waiting', () => waiting++);
		player.addEventListener('resume', () => resumed++);
		const block = fixture.getProbe().buffer.delayPlayback();
		await waitFor(() => waiting > 0 && clock!.context.state === 'suspended');
		const bufferedFrame = player.getCurrentFrame();
		await wait(150);
		expect(player.getCurrentFrame()).toBe(bufferedFrame);
		block.unblock();
		await waitFor(
			() => resumed > 0 && player.getCurrentFrame() > bufferedFrame + 3,
		);
		await waitFor(() => fixture.peak() > 0.001);

		player.pause();
		for (const frame of [120, 15, 180, 60]) player.seekTo(frame);
		await waitFor(() => player.getCurrentFrame() === 60);
		fixture.update(2);
		await waitFor(() => player.getAudioClock()?.playbackRate === 2);
		expect(player.getAudioClock()?.context).toBe(clock!.context);
		expect(player.getAudioClock()?.anchor).toBe(clock!.anchor);
		const framesBeforeResume = fixture.getDrawnFrames();
		player.play();
		await waitFor(
			() => player.getCurrentFrame() > 65 && fixture.peak() > 0.001,
		);
		expect(fixture.getDrawnFrames()).toBeGreaterThan(framesBeforeResume);
		expect(Number.isFinite(player.getAudioClock()!.anchor.value)).toBe(true);
	} finally {
		fixture.unmount();
	}
}, 30000);

test('premounted native media stays silent until active and keeps playing across loops', async () => {
	const fixture = await mountPlayer({
		from: 30,
		durationInFrames: 75,
		keepAudioContextAlive: false,
	});
	const {player} = fixture;
	try {
		const canvas = fixture.container.querySelector(
			'[data-testid="native-video"]',
		);
		expect(canvas).toBeInstanceOf(HTMLCanvasElement);
		expect(canvas?.getAttribute('style')).toContain('display: none');
		expect(fixture.peak()).toBe(0);
		player.play();
		await waitFor(() => player.getCurrentFrame() >= 10);
		expect(player.getCurrentFrame()).toBeLessThan(30);
		expect(fixture.peak()).toBe(0);
		await waitFor(
			() => player.getCurrentFrame() >= 35 && fixture.peak() > 0.001,
		);
		expect(canvas?.getAttribute('style')).not.toContain('display: none');
		let previous = player.getCurrentFrame();
		let looped = false;
		player.addEventListener('frameupdate', ({detail}) => {
			looped ||= detail.frame < previous;
			previous = detail.frame;
		});
		await waitFor(() => looped);
		await waitFor(
			() => player.getCurrentFrame() >= 35 && fixture.peak() > 0.001,
		);
		expect(player.getAudioClock()?.context.state).toBe('running');
		expect(fixture.getDrawnFrames()).toBeGreaterThan(20);
	} finally {
		fixture.unmount();
	}
}, 30000);

test('native keepalive audio reanchors after pause and buffering without advancing the timeline', async () => {
	const fixture = await mountPlayer({
		from: 0,
		durationInFrames: 300,
		keepAudioContextAlive: true,
	});
	const {player} = fixture;
	try {
		player.play();
		await waitFor(() => player.getCurrentFrame() > 5 && fixture.peak() > 0.001);
		const clock = player.getAudioClock()!;
		player.pause();
		const pausedFrame = player.getCurrentFrame();
		const pausedContextTime = clock.context.currentTime;
		await wait(230);
		expect(clock.context.state).toBe('running');
		expect(clock.context.currentTime).toBeGreaterThan(pausedContextTime + 0.1);
		expect(player.getCurrentFrame()).toBe(pausedFrame);
		expect(fixture.peak()).toBeLessThan(0.00001);
		player.play();
		await waitFor(
			() =>
				player.getCurrentFrame() > pausedFrame + 4 && fixture.peak() > 0.001,
		);
		expect(
			Math.abs(
				(clock.context.currentTime - clock.anchor.value) * clock.fps -
					player.getCurrentFrame(),
			),
		).toBeLessThan(3);

		let waiting = false;
		player.addEventListener('waiting', () => {
			waiting = true;
		});
		const block = fixture.getProbe().buffer.delayPlayback();
		await waitFor(() => waiting);
		const bufferedFrame = player.getCurrentFrame();
		await wait(230);
		expect(clock.context.state).toBe('running');
		expect(player.getCurrentFrame()).toBe(bufferedFrame);
		expect(fixture.peak()).toBeLessThan(0.00001);
		block.unblock();
		await waitFor(
			() =>
				player.getCurrentFrame() > bufferedFrame + 4 && fixture.peak() > 0.001,
		);
		expect(
			Math.abs(
				(clock.context.currentTime - clock.anchor.value) * clock.fps -
					player.getCurrentFrame(),
			),
		).toBeLessThan(3);
	} finally {
		fixture.unmount();
	}
}, 30000);

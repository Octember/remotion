import type {RefObject} from 'react';
import React, {
	createContext,
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import {
	createRuntimeValueStore,
	type RuntimeValueStoreController,
} from './runtime-value-store.js';
import {
	getInitialFrameState,
	type PlayableMediaTag,
} from './timeline-position-state';
import {useDelayRender} from './use-delay-render';

export type TimelineContextValue = {
	frame: Record<string, number>;
	isPlaying: () => boolean;
	audioAndVideoTags: RefObject<PlayableMediaTag[]>;
};

export type PlaybackRateContextValue = {
	playbackRate: number;
	setPlaybackRate: (u: React.SetStateAction<number>) => void;
};

export type PlaybackState = Readonly<{
	playing: boolean;
	buffering: boolean;
}>;

export const updatePlaybackState = (
	playbackStore: RuntimeValueStoreController<PlaybackState>,
	update: Partial<PlaybackState>,
) => {
	const current = playbackStore.store.getSnapshot();
	const next = {...current, ...update};

	if (
		next.playing !== current.playing ||
		next.buffering !== current.buffering
	) {
		playbackStore.setSnapshot(next);
	}
};

export type SetTimelineContextValue = {
	setFrame: (u: React.SetStateAction<Record<string, number>>) => void;
	setPlaying: (u: React.SetStateAction<boolean>) => void;
	setBuffering: (buffering: boolean) => void;
	subscribePlayback: (
		listener: (state: PlaybackState, previousState: PlaybackState) => void,
	) => () => void;
	isBuffering: () => boolean;
	frameRef: RefObject<Record<string, number>>;
	audioAndVideoTags: RefObject<PlayableMediaTag[]>;
};

export const SetTimelineContext = createContext<SetTimelineContextValue>({
	setFrame: () => {
		throw new Error('default');
	},
	setPlaying: () => {
		throw new Error('default');
	},
	setBuffering: () => undefined,
	subscribePlayback: () => () => undefined,
	isBuffering: () => false,
	frameRef: {current: {}},
	audioAndVideoTags: {current: []},
});

export const TimelineContext = createContext<TimelineContextValue | null>(null);

export const PlaybackRateContext =
	createContext<PlaybackRateContextValue | null>(null);

export const AbsoluteTimeContext = createContext<TimelineContextValue | null>(
	null,
);

export const TimelineContextProvider: React.FC<{
	readonly children: React.ReactNode;
	readonly frameState: Record<string, number> | null;
}> = ({children, frameState}) => {
	const playbackStore = useMemo(
		() => createRuntimeValueStore({playing: false, buffering: false}),
		[],
	);

	const [playbackRate, setPlaybackRate] = useState(1);
	const audioAndVideoTags = useRef<PlayableMediaTag[]>([]);
	const [_frame, setFrame] = useState<Record<string, number>>(() =>
		getInitialFrameState(),
	);

	const frame = frameState ?? _frame;
	const frameRef = useRef(frame);
	frameRef.current = frame;

	const readIsPlaying = useCallback(
		() => playbackStore.store.getSnapshot().playing,
		[playbackStore],
	);
	const readIsBuffering = useCallback(
		() => playbackStore.store.getSnapshot().buffering,
		[playbackStore],
	);

	const {delayRender, continueRender} = useDelayRender();

	if (typeof window !== 'undefined') {
		// eslint-disable-next-line react-hooks/rules-of-hooks
		useLayoutEffect(() => {
			window.remotion_setFrame = (f: number, composition: string, attempt) => {
				window.remotion_attempt = attempt;
				const id = delayRender(`Setting the current frame to ${f}`);

				let asyncUpdate = true;

				setFrame((s) => {
					const currentFrame = s[composition] ?? window.remotion_initialFrame;
					// Avoid cloning the object
					if (currentFrame === f) {
						asyncUpdate = false;
						return s;
					}

					return {
						...s,
						[composition]: f,
					};
				});

				// After setting the state, need to wait until it is applied in the next cycle
				if (asyncUpdate) {
					requestAnimationFrame(() => continueRender(id));
				} else {
					continueRender(id);
				}
			};

			window.remotion_isPlayer = false;
		}, [continueRender, delayRender]);
	}

	const timelineContextValue = useMemo((): TimelineContextValue => {
		return {
			frame,
			isPlaying: readIsPlaying,
			audioAndVideoTags,
		};
	}, [frame, readIsPlaying]);

	const playbackRateContextValue = useMemo((): PlaybackRateContextValue => {
		return {
			playbackRate,
			setPlaybackRate,
		};
	}, [playbackRate]);

	const setTimelineContextValue = useMemo((): SetTimelineContextValue => {
		return {
			setFrame,
			setPlaying: (updater) => {
				const current = playbackStore.store.getSnapshot().playing;
				const next = typeof updater === 'function' ? updater(current) : updater;
				updatePlaybackState(playbackStore, {playing: next});
			},
			setBuffering: (buffering) => {
				updatePlaybackState(playbackStore, {buffering});
			},
			subscribePlayback: playbackStore.store.subscribe,
			isBuffering: readIsBuffering,
			frameRef,
			audioAndVideoTags,
		};
	}, [playbackStore, readIsBuffering]);

	return (
		<AbsoluteTimeContext.Provider value={timelineContextValue}>
			<PlaybackRateContext.Provider value={playbackRateContextValue}>
				<TimelineContext.Provider value={timelineContextValue}>
					<SetTimelineContext.Provider value={setTimelineContextValue}>
						{children}
					</SetTimelineContext.Provider>
				</TimelineContext.Provider>
			</PlaybackRateContext.Provider>
		</AbsoluteTimeContext.Provider>
	);
};

import {useContext, useLayoutEffect} from 'react';
import {Internals} from 'remotion';
import type {PlayerEmitter, ThumbnailEmitter} from './event-emitter.js';

export const useBufferStateEmitter = (
	emitter: PlayerEmitter | ThumbnailEmitter,
) => {
	const {subscribePlayback} = useContext(Internals.SetTimelineContext);

	useLayoutEffect(() => {
		return subscribePlayback((state, previousState) => {
			if (state.buffering === previousState.buffering) {
				return;
			}

			if (state.buffering) {
				emitter.dispatchWaiting({});
			} else {
				emitter.dispatchResume({});
			}
		});
	}, [emitter, subscribePlayback]);
};

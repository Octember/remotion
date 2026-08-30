import {useContext, useSyncExternalStore} from 'react';
import {SetTimelineContext} from './TimelineContext.js';

export const useBuffering = () => {
	const {isBuffering, subscribePlayback} = useContext(SetTimelineContext);
	return useSyncExternalStore(subscribePlayback, isBuffering, isBuffering);
};

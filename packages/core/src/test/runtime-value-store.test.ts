import {expect, test} from 'bun:test';
import {createRuntimeValueStore} from '../runtime-value-store.js';
import {updatePlaybackState} from '../TimelineContext.js';

test('publishes the current and previous snapshots', () => {
	const controller = createRuntimeValueStore({
		playing: false,
		buffering: false,
	});
	const transitions: unknown[] = [];
	controller.store.subscribe((current, previous) => {
		transitions.push({current, previous});
	});

	controller.setSnapshot({playing: true, buffering: false});

	expect(transitions).toEqual([
		{
			current: {playing: true, buffering: false},
			previous: {playing: false, buffering: false},
		},
	]);
});

test('does not publish unchanged playback state', () => {
	const controller = createRuntimeValueStore({
		playing: false,
		buffering: false,
	});
	let notifications = 0;
	controller.store.subscribe(() => {
		notifications++;
	});

	updatePlaybackState(controller, {playing: false});
	updatePlaybackState(controller, {buffering: true});

	expect(notifications).toBe(1);
	expect(controller.store.getSnapshot()).toEqual({
		playing: false,
		buffering: true,
	});
});

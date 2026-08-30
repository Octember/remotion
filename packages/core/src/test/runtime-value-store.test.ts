import {expect, test} from 'bun:test';
import {createRuntimeValueStore} from '../runtime-value-store.js';

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

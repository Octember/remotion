import {Effect, Semaphore} from 'effect';

export const makeSerializedQueue = () => {
	const semaphore = Semaphore.makeUnsafe(1);

	return <T>(fn: () => Promise<T> | T): Promise<T> => {
		const result = Effect.runPromise(
			semaphore.withPermit(
				Effect.tryPromise({
					try: () => Promise.resolve().then(fn),
					catch: (error) => error,
				}),
			),
		);
		result.catch(() => undefined);

		return result;
	};
};

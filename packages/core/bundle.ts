import {build, semver, version} from 'bun';

if (process.env.NODE_ENV !== 'production') {
	throw new Error('This script must be run using NODE_ENV=production');
}

if (!semver.satisfies(version, '^1.1.7')) {
	// eslint-disable-next-line no-console
	console.error(
		`There is a bug with bundling when using Bun <1.1.7. You use ${version}. Please use a newer version`,
	);
	process.exit(1);
}

for (const format of ['esm', 'cjs'] as const) {
	const output = await build({
		entrypoints: ['src/index.ts', 'src/version.ts', 'src/no-react.ts'],
		outdir: `dist/${format}`,
		naming: `[name].${format === 'esm' ? 'mjs' : 'js'}`,
		format,
		target: 'browser',
		external: [
			'remotion',
			'remotion/no-react',
			'react',
			'react-dom',
			...(format === 'esm' ? ['effect'] : []),
		],
	});
	if (!output.success) {
		throw new AggregateError(output.logs, 'Failed to build remotion');
	}

	const noReactFile = output.outputs.find((file) =>
		file.path.includes('/no-react.'),
	)!;
	if ((await noReactFile.text()).includes('createContext')) {
		throw new Error('remotion/no-react should not import React');
	}
}

export {};

console.log('Done.');

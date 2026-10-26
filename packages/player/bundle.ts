import {build} from 'bun';

if (process.env.NODE_ENV !== 'production') {
	throw new Error('This script must be run using NODE_ENV=production');
}

for (const format of ['esm', 'cjs'] as const) {
	const output = await build({
		entrypoints: ['src/index.ts'],
		outdir: `dist/${format}`,
		naming: `[name].${format === 'esm' ? 'mjs' : 'js'}`,
		format,
		target: 'node',
		banner: '"use client";',
		external: [
			'remotion',
			'remotion/no-react',
			'react',
			...(format === 'esm' ? ['effect'] : []),
		],
	});
	if (!output.success) {
		throw new AggregateError(output.logs, 'Failed to build @remotion/player');
	}
}

export {};

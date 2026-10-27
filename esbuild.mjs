// Bundles the React webviews in webview-ui/ into out/webview-ui/<entry>.js + .css.
//   node esbuild.mjs               one-off development build
//   node esbuild.mjs --watch       rebuild on change (used by the "watch" task)
//   node esbuild.mjs --production  minified build for packaging
// Type checking is separate (tsc -p webview-ui); esbuild only strips types.
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** Prints build start/end and errors in the format the "watch:webview" task's problem matcher reads. */
const problemMatcher = {
    name: 'problem-matcher',
    setup(build) {
        build.onStart(() => console.log('[watch] build started'));
        build.onEnd(result => {
            for (const { text, location } of result.errors) {
                console.error(`✘ [ERROR] ${text}`);
                if (location) { console.error(`    ${location.file}:${location.line}:${location.column}:`); }
            }
            console.log('[watch] build finished');
        });
    },
};

const ctx = await esbuild.context({
    entryPoints: {
        connectionEditor: 'webview-ui/connectionEditor/index.tsx',
        columnPicker: 'webview-ui/columnPicker/index.tsx',
        grid: 'webview-ui/grid/index.tsx',
    },
    outdir: 'out/webview-ui',
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    minify: production,
    // linked maps with embedded sources: breakpoints in .tsx files bind under the debugger,
    // and the maps are excluded from the packaged .vsix by .vscodeignore
    sourcemap: 'linked',
    sourcesContent: true,
    define: { 'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development') },
    logLevel: 'silent',
    plugins: [problemMatcher],
});

if (watch) {
    await ctx.watch();
} else {
    const result = await ctx.rebuild();
    await ctx.dispose();
    if (result.errors.length) { process.exit(1); }
}

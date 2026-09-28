// Builds the review app's script from source, for the dev server and tests.
// The published relay carries the script built by scripts/build.mjs with the
// same options.
import { fileURLToPath } from 'node:url';

export const appBuildOptions = { bundle: true, platform: 'browser', format: 'esm', target: 'es2022', write: false } as const;

export async function buildReviewApp(): Promise<string> {
  const { build } = await import('esbuild');
  const result = await build({ ...appBuildOptions, entryPoints: [fileURLToPath(new URL('./main.ts', import.meta.url))] });
  return result.outputFiles[0]!.text;
}

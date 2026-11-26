// Copies web/ into www/ and bundles src/shim.js (the Android replacement for Electron's main process).
import { build } from 'esbuild';
import { cpSync, rmSync, mkdirSync } from 'node:fs';

rmSync('www', { recursive: true, force: true });
mkdirSync('www', { recursive: true });
cpSync('web', 'www', { recursive: true });

await build({
  entryPoints: ['src/shim.js'],
  outfile: 'www/shim.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome100'],
  minify: true,
  define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});
console.log('Web build done -> www/');

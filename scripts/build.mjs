#!/usr/bin/env node
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
/**
 * Compiles src/entry/*.ts into extension/*.js.
 *
 * Bundled, because Chrome executes an injected script as a classic script and
 * MV3 gives it no module loader — but never minified. The published output has
 * to stay readable, since "the code on GitHub is the code that runs" is the
 * only reason anyone should trust this with their conversations.
 */
import { build } from 'esbuild'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const outdir = path.join(root, 'extension')

const entries = [
  { in: 'src/entry/background.ts', out: 'background' },
  { in: 'src/entry/collector.ts', out: 'collector' },
  { in: 'src/entry/page.ts', out: 'page' },
]

for (const entry of entries) {
  await rm(path.join(outdir, `${entry.out}.js`), { force: true })
}

await build({
  entryPoints: entries.map((e) => ({ in: path.join(root, e.in), out: e.out })),
  outdir,
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  platform: 'browser',
  minify: false,
  legalComments: 'inline',
  charset: 'utf8',
  tsconfig: path.join(root, 'tsconfig.json'),
  banner: { js: '// Built from src/ by scripts/build.mjs — do not edit. Run `npm run verify`.' },
})

console.log(`built ${entries.length} bundles into extension/`)

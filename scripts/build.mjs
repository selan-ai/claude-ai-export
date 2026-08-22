#!/usr/bin/env node
import { cp, mkdir, rm } from 'node:fs/promises'
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

// extension/ is entirely generated. Wiping it before every build is what makes
// that true rather than aspirational: nothing can survive there by accident,
// and an edit made in the wrong place is noticed immediately instead of
// quietly outliving the source it came from.
await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })
await cp(path.join(root, 'src/static'), outdir, {
  recursive: true,
  filter: () => true,
})

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

console.log(`built ${entries.length} bundles and copied static assets into extension/`)

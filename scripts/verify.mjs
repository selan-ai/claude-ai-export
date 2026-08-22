#!/usr/bin/env node
/**
 * Rebuilds and confirms the committed bundles match the source.
 *
 * This is what makes the trust claim checkable by a stranger: clone, run
 * `npm run verify`, and see that extension/*.js really is what src/ produces.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const artefacts = [
  'background.js',
  'collector.js',
  'page.js',
  'manifest.json',
  'export.html',
  'export.css',
]

const digest = async (file) =>
  createHash('sha256')
    .update(await readFile(path.join(root, 'extension', file)))
    .digest('hex')

const before = Object.fromEntries(
  await Promise.all(artefacts.map(async (b) => [b, await digest(b)])),
)
execFileSync('node', [path.join(root, 'scripts/build.mjs')], { stdio: 'inherit' })
const after = Object.fromEntries(
  await Promise.all(artefacts.map(async (b) => [b, await digest(b)])),
)

const drifted = artefacts.filter((b) => before[b] !== after[b])
for (const bundle of artefacts) {
  console.log(
    `${drifted.includes(bundle) ? 'DRIFT ' : 'ok    '}${bundle}  ${after[bundle].slice(0, 16)}`,
  )
}

if (drifted.length > 0) {
  console.error(`\n${drifted.length} artefact(s) differ from src/. Run npm run build and commit.`)
  process.exit(1)
}
console.log('\nEverything in extension/ matches src/.')

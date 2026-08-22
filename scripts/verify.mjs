#!/usr/bin/env node
/**
 * Rebuilds and confirms every committed artefact matches the source.
 *
 * This is what makes the trust claim checkable by a stranger: clone, run
 * `npm run verify`, and see that extension/ really is what src/ produces.
 *
 * It walks the directory rather than checking a list, so an artefact added
 * later cannot quietly escape the check.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const outdir = path.join(root, 'extension')

async function fingerprint() {
  const entries = await readdir(outdir, { recursive: true, withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(outdir, path.join(entry.parentPath, entry.name)))
    .sort()

  return new Map(
    await Promise.all(
      files.map(async (file) => {
        const bytes = await readFile(path.join(outdir, file))
        return [file, createHash('sha256').update(bytes).digest('hex')]
      }),
    ),
  )
}

const before = await fingerprint()
execFileSync('node', [path.join(root, 'scripts/build.mjs')], { stdio: 'inherit' })
const after = await fingerprint()

const names = [...new Set([...before.keys(), ...after.keys()])].sort()
const drifted = names.filter((name) => before.get(name) !== after.get(name))

for (const name of names) {
  const digest = after.get(name) ?? '(removed)'
  console.log(
    `${drifted.includes(name) ? 'DRIFT ' : 'ok    '}${name.padEnd(22)}${digest.slice(0, 16)}`,
  )
}

if (drifted.length > 0) {
  console.error(`\n${drifted.length} artefact(s) differ from src/. Run npm run build and commit.`)
  process.exit(1)
}
console.log(`\nAll ${names.length} artefacts in extension/ match src/.`)

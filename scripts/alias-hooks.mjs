/**
 * Resolves the `@/` alias for Node's test runner.
 *
 * tsconfig `paths` is understood by TypeScript and by esbuild, but not by
 * Node — and Node's own `imports` field only accepts `#`-prefixed specifiers.
 * So the alias is taught to the loader here, in one place.
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const sourceRoot = path.join(path.dirname(import.meta.dirname), 'src')

export function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith('@/')) return nextResolve(specifier, context)
  const target = path.join(sourceRoot, `${specifier.slice(2)}.ts`)
  return nextResolve(pathToFileURL(target).href, context)
}

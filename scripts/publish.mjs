#!/usr/bin/env node
/**
 * Uploads a packaged extension to the Chrome Web Store and publishes it.
 *
 *     node scripts/publish.mjs claude-ai-export-v0.1.0.zip
 *
 * No dependency: the Web Store API is three HTTP calls, and `fetch` is built
 * in. Adding a publisher library here would mean auditing one more package in
 * a repo whose whole argument is that there is nothing to audit.
 *
 * Credentials come from the environment. See docs/PUBLISHING.md for how to
 * mint them once; after that they live as masked, protected CI/CD variables
 * and nothing here ever prints one.
 */
import { readFile } from 'node:fs/promises'

const tokenEndpoint = 'https://oauth2.googleapis.com/token'
const uploadEndpoint = 'https://www.googleapis.com/upload/chromewebstore/v1.1/items'
const itemsEndpoint = 'https://www.googleapis.com/chromewebstore/v1.1/items'

/** Published to everyone rather than to a trusted-tester group. */
const publishTarget = 'default'

function required(name) {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set. See docs/PUBLISHING.md.`)
  }
  return value
}

async function accessToken(clientId, clientSecret, refreshToken) {
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  if (!response.ok) {
    // Deliberately not echoing the body: it can contain the credential.
    throw new Error(`token exchange failed (${response.status})`)
  }
  const body = await response.json()
  return body.access_token
}

/**
 * The Web Store answers 200 with an error *inside* the body, so the HTTP status
 * alone is not enough to tell a successful upload from a rejected one.
 */
function assertOk(stage, body) {
  const state = body.uploadState ?? body.status
  const failed =
    body.uploadState === 'FAILURE' ||
    (Array.isArray(body.status) && body.status.some((s) => s !== 'OK'))
  if (failed) {
    const detail = body.itemError?.map((e) => e.error_detail).join('; ') ?? body.statusDetail
    throw new Error(`${stage} rejected: ${detail ?? JSON.stringify(body)}`)
  }
  console.log(`${stage}: ${JSON.stringify(state)}`)
}

const archivePath = process.argv[2]
if (archivePath === undefined) {
  console.error('usage: node scripts/publish.mjs <archive.zip>')
  process.exit(2)
}

const extensionId = required('CWS_EXTENSION_ID')
const token = await accessToken(
  required('CWS_CLIENT_ID'),
  required('CWS_CLIENT_SECRET'),
  required('CWS_REFRESH_TOKEN'),
)
// Lower-case: header names are case-insensitive, HTTP/2 requires them
// lower-cased, and fetch normalises them anyway.
const authorization = { authorization: `Bearer ${token}`, 'x-goog-api-version': '2' }

console.log(`uploading ${archivePath} to ${extensionId}`)
const upload = await fetch(`${uploadEndpoint}/${extensionId}`, {
  method: 'PUT',
  headers: authorization,
  body: await readFile(archivePath),
})
assertOk('upload', await upload.json())

const publish = await fetch(`${itemsEndpoint}/${extensionId}/publish`, {
  method: 'POST',
  headers: { ...authorization, 'Content-Length': '0' },
  body: new URLSearchParams({ publishTarget }),
})
assertOk('publish', await publish.json())

console.log('submitted. The Web Store review usually takes a few days.')

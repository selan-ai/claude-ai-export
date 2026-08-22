# Privacy Policy

**Claude AI Export** — last updated 22 August 2026.

## Summary

This extension collects nothing, transmits nothing, and has no server.

Your conversations are read from claude.ai in your browser, written into a zip
file, and saved to your computer's Downloads folder. Nothing else happens to
them.

## What the extension accesses

When you click **Start export**, it reads, from the claude.ai account you are
already signed in to:

- your conversations and their messages
- your projects, their instructions and knowledge documents
- files and images you attached to those conversations
- your scheduled tasks

It reads nothing else, and only when you ask it to.

## Where that data goes

Into a `.zip` file in your Downloads folder. That is the only destination.

There is no analytics, no telemetry, no error reporting, no remote
configuration, and no account. The extension has no backend, so there is
nowhere for your data to be sent even in principle.

## How you can verify that

You do not have to take our word for it. The extension may only contact
claude.ai, and this is enforced by the browser rather than by our good
intentions:

```json
"permissions": ["scripting"],
"host_permissions": ["https://claude.ai/*"],
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'none'"
}
```

`claude.ai` is the only host it is permitted to reach. The content security
policy forbids loading code from anywhere. Chrome enforces both.

The full source is at
[github.com/selan-ai/claude-ai-export](https://github.com/selan-ai/claude-ai-export),
and the published bundles are reproducible from it — `npm run verify` rebuilds
them and fails if a single byte differs from what is published.

## Your claude.ai session

The extension never reads, stores, or transmits your session cookie. It asks
the browser to attach your existing session to its requests to claude.ai
(`credentials: 'include'`), which means the browser handles the credential and
the extension never sees its value.

## Permissions, and why each exists

| Permission | Why |
|---|---|
| `https://claude.ai/*` | To read your data from claude.ai. It is the only host contacted. |
| `scripting` | The export runs inside a claude.ai tab, because your session cookie is `httpOnly` and only a request from that origin carries it. |

## Children

The extension is not directed at children and collects no data from anyone.

## Changes

Any change to this policy will be committed to the public repository, so its
full history is visible in
[the file's git log](https://github.com/selan-ai/claude-ai-export/commits/main/PRIVACY.md).

## Contact

Open an issue at
[github.com/selan-ai/claude-ai-export/issues](https://github.com/selan-ai/claude-ai-export/issues).

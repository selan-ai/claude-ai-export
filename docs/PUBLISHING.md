# Publishing

Tagging `v*` builds a zip. Publishing it is a manual job on that pipeline,
because a Web Store submission enters review and cannot be recalled once it
goes live — the tag says *this is releasable*, a person says *release it*.

Everything below the first section is a one-time setup.

## Releasing

```bash
npm version patch          # bumps package.json
# bump "version" in src/static/manifest.json to match, then rebuild
npm run build && npm run check
git commit -am 'Release v0.1.1' && git tag v0.1.1
git push && git push --tags
```

Then open the tag's pipeline and run the `publish` job.

The Web Store rejects a version that is not higher than the published one, and
`manifest.json` is what it reads — not `package.json`. Keeping the two in step
is currently a human step; if it is ever forgotten twice, make the build derive
one from the other.

## One-time: a Web Store account

1. Sign in at [chrome.google.com/webstore/devconsole](https://chrome.google.com/webstore/devconsole)
   with the account that should own the listing — an organisational one, not a
   personal one, or moving it later means a transfer request.
2. Pay the one-off registration fee (5 USD).
3. Build a zip locally (`npm run check && cd extension && zip -r -X ../first.zip .`)
   and upload it by hand. This first upload is what mints the **extension ID**,
   which nothing can do for you.
4. Fill in the listing: description, screenshots, a privacy policy URL, and the
   permission justifications.

### Permission justifications

The reviewer will ask. The honest answers are short:

- **`scripting`** — the export runs inside a claude.ai tab because the session
  cookie is `httpOnly`; only a same-origin request carries it.
- **`https://claude.ai/*`** — the only host contacted. There is no server.
- **Single purpose** — exporting the signed-in user's own claude.ai data to a
  file on their computer.
- **Remote code** — none. The CSP forbids it and the bundles are committed.

Data disclosure: no data is collected, sold, or transmitted anywhere. Everything
stays in the browser and lands in the user's Downloads folder.

## One-time: API credentials

The Web Store API is OAuth2. Four values end up as **masked, protected** CI/CD
variables in GitLab.

1. In a Google Cloud project, enable the **Chrome Web Store API**.
2. Create an **OAuth client ID** of type *Desktop app*. Note the client ID and
   secret.
3. Mint a refresh token once, with your own account, in a browser:

   ```
   https://accounts.google.com/o/oauth2/auth
     ?response_type=code
     &scope=https://www.googleapis.com/auth/chromewebstore
     &client_id=<CLIENT_ID>
     &redirect_uri=urn:ietf:wg:oauth:2.0:oob
     &access_type=offline
     &prompt=consent
   ```

   Exchange the code it returns:

   ```bash
   curl -s https://oauth2.googleapis.com/token \
     -d client_id=<CLIENT_ID> \
     -d client_secret=<CLIENT_SECRET> \
     -d code=<CODE> \
     -d grant_type=authorization_code \
     -d redirect_uri=urn:ietf:wg:oauth:2.0:oob | jq -r .refresh_token
   ```

   `access_type=offline` **and** `prompt=consent` both matter: without them
   Google returns an access token only, and the pipeline has nothing durable.

4. Add to *Settings → CI/CD → Variables*, each **masked** and **protected**:

   | Variable | Value |
   |---|---|
   | `CWS_EXTENSION_ID` | from the first manual upload |
   | `CWS_CLIENT_ID` | OAuth client |
   | `CWS_CLIENT_SECRET` | OAuth client |
   | `CWS_REFRESH_TOKEN` | minted above |

   Protected matters: only protected refs may read them, and tags matching `v*`
   should be the protected pattern. Otherwise anyone able to push a branch could
   run a job that reads publishing credentials.

The refresh token does not expire on a schedule, but it is revoked if the
password changes, if the OAuth client is deleted, or if the project's consent
screen stays in *Testing* — publish it, or the token dies after seven days.

## Firefox and Edge

Not set up. Edge takes the same zip through Partner Center. Firefox needs a
manifest variant (`browser_specific_settings`, and MV3 background differences)
before it is worth attempting.

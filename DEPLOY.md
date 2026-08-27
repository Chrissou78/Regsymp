# Deploying RegSymp

The site is an [Eleventy](https://www.11ty.dev/) build. `npm run build` writes
static files to `_site/`, and `server.js` serves them and runs the invitation
endpoint in the same process.

## Railpack (our own host)

`railpack.json` pins Node 22 and sets the start command. Railpack detects the
Node provider from `package.json`, installs dependencies, runs the `build`
script, then runs `npm start`.

No further configuration is needed. Note that Eleventy is a **runtime**
dependency rather than a dev dependency on purpose: builders that install with
`NODE_ENV=production` skip `devDependencies`, which would leave the build with
no Eleventy.

The server binds `PORT` (default 3000) and `HOST` (default `0.0.0.0`).

### Environment variables

The invitation form needs all three. Without them the endpoint still validates
input, but returns a 502 telling the visitor to email instead — it never fails
silently.

| Variable | Value |
|---|---|
| `RESEND_API_KEY` | from resend.com |
| `RESEND_FROM` | a verified sender, e.g. `RegSymp <noreply@regsymp.com>` |
| `INVITATION_RECIPIENT` | `info@regsymp.com` |

Resend also needs SPF and DKIM records on `regsymp.com` before it will deliver
reliably. Adding the key without the DNS records is not enough.

## Vercel

`vercel.json` sets the build command, output directory, clean URLs and cache
headers. `api/request-invitation.js` runs as a serverless function.

Both hosts share one implementation: `api/_lib/send-invitation.js` does the
validating and sending, and the Vercel function and `server.js` are thin
wrappers over it. Change the behaviour there, not in two places.

## Local

```bash
npm install
npm run dev     # Eleventy dev server with live reload, port 8091
npm run build   # production build into _site/
npm start       # run the production server against _site/
npm test        # build, then 46 tests
```

## What the tests cover

`npm test` builds first, then asserts against the real output: every page has
nav, footer, canonical and OG tags; exactly one `h1`; every image carries
width and height; JSON-LD parses; no internal link 404s; and **every image
reference resolves with exactly matching case**.

That last one is not theoretical. Four speaker photos and the whole carousel
pointed at paths whose casing differed from the files on disk. Windows and
macOS resolve those happily; Linux does not, so they were 404ing in production
while looking fine locally.

`tests/server.test.js` covers the production server: clean-URL redirects,
cache headers, ETag/304, path-traversal rejection, and the API's validation
and failure modes.

## Admin interface

`/admin` manages every file in `src/_data/` and the images they reference.
Each change is committed to git, so history, attribution and rollback come
free.

It is **disabled unless `GITHUB_CLIENT_ID` is set**, so deploying this code
without configuring it exposes nothing.

### Setup

1. Register a GitHub OAuth app with the callback URL
   `https://regsymp.com/admin/auth/callback`.
2. Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `ADMIN_ALLOWLIST` and
   `SESSION_SECRET` in the environment, then restart.
3. Sign in at `/admin` with a GitHub account on the allowlist.

Commits are made with the signed-in user's token, so the git log records who
changed what. The allowlist fails closed: if it is empty, nobody can sign in.

### `prod` must never be force-pushed

Content now lives on `OC-Labs/regsymp@prod`. Deploys used to end with
`git push prod prod --force-with-lease`, which rewrites that branch to match
`main` — that would delete every content edit.

Code changes flow:

```bash
git push origin main
git checkout prod && git merge main --no-edit
git push prod prod          # no --force
git checkout main
```

### Images

Uploaded filenames are slugified automatically: lowercase, ASCII, no spaces,
extension forced to the sniffed file type. `Rony Vogel.png` becomes
`rony-vogel.png`. This is not cosmetic — four speaker photos and every
carousel image once 404'd in production because a referenced path differed in
case from the file on disk, which Windows and macOS hide and Linux does not.

Uploads are validated by magic bytes rather than the declared content type,
capped at 8 MB, and never overwrite an existing file.

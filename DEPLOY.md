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
Each change is committed to git, so history and rollback come free.

Admin accounts live in the content repository, not the environment, so adding
an admin needs no server access at all — an existing admin invites a colleague
from the web interface.

It is **disabled unless `GITHUB_TOKEN` is set**, so deploying this code without
configuring it exposes nothing. The gate is the token rather than the account
list, because without a token the admin can neither read accounts nor commit.

### Setup

Set two variables in the host's dashboard and restart:

```
GITHUB_TOKEN=github_pat_...
SESSION_SECRET=<random hex>
```

No quotes around either value. Generate the secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`CONTENT_REPO` and `CONTENT_BRANCH` default to `OC-Labs/regsymp` and `prod`,
so they only need setting if that changes.

Then open the invitation link for the first account, set a password, and sign
in. Every account after that is created from **Manage admin accounts** inside
the admin.

### The GitHub token

Content edits are committed with `GITHUB_TOKEN`, so it needs write access to
`CONTENT_REPO`. A fine-grained personal access token with **Contents: Read and
write**, scoped to that single repository, is sufficient.

Because one token makes every commit, git records the change but not which
person made it. The signed-in email goes into each commit message, so the
history is still attributable by reading it.

### Accounts and invitations

Accounts are stored in `admin/users.json` on the content branch. That file
exists **only on `prod`**, which is private: `main` mirrors to a public
repository and password hashes do not belong there. It is listed in
`.gitignore` so it cannot reach `main` by accident.

- Invitations are single-use and expire after seven days.
- Only the SHA-256 digest of an invitation token is stored, so a copy of the
  file does not let anyone redeem an outstanding invitation.
- The last remaining admin cannot be removed.
- `ADMIN_USERS` still works as an environment fallback, for recovery if the
  stored file is ever damaged. It is not needed in normal operation.

### Sign-in security

- Passwords are hashed with scrypt (N=16384), never stored or logged in clear.
- A wrong password and an unknown account return byte-identical responses, and
  both run the full key derivation, so neither the body nor the timing reveals
  which addresses exist.
- Eight failed attempts from one address triggers a 15-minute lockout, counted
  per source so one attacker cannot lock everyone out.
- Sessions are held server-side; the cookie carries only an opaque id, and is
  `HttpOnly`, `Secure` and `SameSite=Lax`.
- Sessions live in memory, so a restart or redeploy signs everyone out.

### `prod` must never be force-pushed, nor merged back into `main`

Content and admin accounts live on `OC-Labs/regsymp@prod`. A force-push would
delete them, and merging `prod` into `main` would publish password hashes to
the public mirror.

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

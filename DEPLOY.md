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

A save writes to the content volume, copies that file into the working tree
and rebuilds the site in-process — typically under a second. Nothing is
committed, nothing is deployed, and nobody is signed out.

### Why it stopped using git

Content used to be committed through the GitHub API. That worked, but every
save triggered a redeploy, and the redeploy was the problem:

- three to five minutes before an edit appeared;
- every admin signed out when the replacement container took over;
- any configuration held in memory was wiped — including the `GITHUB_TOKEN`
  supplied through the setup link, which is what made saving work at all.

That last one was circular: **using the admin is what broke the admin.** The
volume removes the whole chain. There is no token, no setup link, and no
secret to set.

### Setup

1. **Mount a persistent volume at `/data`.** This is the only infrastructure
   step, and the only one that needs whoever administers the host.
2. Deploy. First boot seeds `/data` from the deployed checkout, so the site
   comes up with the content and the accounts it already had.
3. Check `/api/health` and confirm `content.durable` — see below.

`CONTENT_DIR` overrides the location; `/data` is used automatically when it
exists, and a local `.content/` directory otherwise.

Nothing else is required. `SESSION_SECRET` is generated on first boot and kept
on the volume, and `ADMIN_USERS` remains only as a recovery fallback.

### Confirming the volume is real

An unmounted volume behaves *exactly* like a mounted one — right up until the
next deploy erases everything saved since. So it is verified rather than
assumed:

```bash
curl -s https://regsymp.com/api/health | jq .content
```

| `durable` | Meaning |
|---|---|
| `true` | The content predates this process: it survived a restart. |
| `null` | Seeded during this boot. Unproven until the next restart. |
| `false` | The content is younger than the process — the last restart wiped it. **Not a real volume.** |

While `durable` is not `true`, the admin shows a warning above the collections
saying that changes are temporary. Do not rely on that warning alone: check
after the first restart following any host change.

### Accounts

Accounts live in `admin/users.json` **on the volume**. They are seeded from
the deployed branch on first boot, so existing admins carry over.

A brand-new installation with no accounts serves `/admin/first-run`, which
creates the first account and makes it the owner. That route stops existing
the moment an account exists, so nobody else can claim it.

The **owner** — whichever record carries `owner: true`, or failing that the
first account — is the only one who can manage accounts. Everyone else edits
content and changes their own password.

To add an admin: **Manage admin accounts** → email and a password → **Create
account**. Send them the password; they change it at **Change your password**,
which also signs out that account's other sessions.

### History and rollback

Committing gave history for free, and dropping git would have lost it, so the
store keeps its own. Every overwrite copies the previous version to
`.revisions/<path>/<timestamp>.bak` on the volume, capped at 50 per file. Data
files are a few KB, so this costs almost nothing.

### Sign-in security

- Passwords are hashed with scrypt (N=16384), never stored or logged in clear.
- A wrong password and an unknown account return byte-identical responses, and
  both run the full key derivation, so neither the body nor the timing reveals
  which addresses exist.
- Eight failed attempts from one address triggers a 15-minute lockout, counted
  per source so one attacker cannot lock everyone out.
- Sessions are held server-side; the cookie carries only an opaque id, and is
  `HttpOnly`, `Secure` and `SameSite=Lax`.
- Sessions live in memory, so a restart signs everyone out — but restarts are
  now rare, because saving no longer causes one.

### The volume outranks git

Once seeded, the volume is the source of truth. Editing `src/_data/*.json` in
the repository **no longer changes the live site**: boot copies the volume over
the working tree before building. To change content, use the admin.

This also means the repository's data files drift behind the live site over
time. That is expected. To capture the live state back into git, copy the
volume's `src/_data/` and `src/assets/images/` into a checkout and commit.

### Branches

`main` mirrors to a public repository; `prod` is what deploys.

```bash
git push origin main
git checkout prod && git merge main --no-edit
git push prod prod          # never --force
git checkout main
```

`prod` still carries the last committed content and the accounts file, which is
what a fresh volume seeds from — so it must never be force-pushed, and never
merged back into `main`.

### Images

Uploaded filenames are slugified automatically: lowercase, ASCII, no spaces,
extension forced to the sniffed file type. `Rony Vogel.png` becomes
`rony-vogel.png`. This is not cosmetic — four speaker photos and every
carousel image once 404'd in production because a referenced path differed in
case from the file on disk, which Windows and macOS hide and Linux does not.

Uploads are validated by magic bytes rather than the declared content type,
capped at 8 MB, and never overwrite an existing file.

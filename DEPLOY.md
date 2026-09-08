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

That last one was circular: **using the admin is what broke the admin.** A
database removes the whole chain, and unlike a volume it needs nothing mounted.

### Setup

Set one variable on the host:

```
DATABASE_URL=postgresql://user:password@host:port/database
```

That is the only one required. Either a host-injected environment variable or
a `.env` file at the application root works — a variable already in the
environment wins, since a host setting is more specific than a file in the
image. `/api/health` reports which arrived and from where, under `env`.

Note that a `.env` file inside the container is only useful if the platform
persists or re-injects it; a file written into an ephemeral container goes with
the container. On first boot the server:

1. applies any pending migrations in `admin/migrations/`;
2. generates a session secret and stores it in the database;
3. seeds `content_documents` from the deployed checkout — but only if it is
   empty, so a later deploy can never overwrite live edits;
4. migrates `admin/users.json` into `admin_users`, hashes intact, so existing
   admins keep their passwords;
5. writes the documents to disk and builds.

Steps 3 and 4 are the migration. There is nothing to export or import.

Without `DATABASE_URL` the server falls back to a local content directory,
which is fine for a checkout and **not durable in production** — the admin
says so above the collections when that is the case.

### Service credentials

`RESEND_API_KEY`, `RESEND_FROM`, `INVITATION_RECIPIENT` and `SESSION_SECRET`
live in the `app_secrets` table and are loaded into the environment at boot.
The owner manages them at **/admin/credentials**; values are never displayed.

The database wins over a host environment variable of the same name. That is
deliberate: otherwise changing a credential in the admin would appear to work
while a stale dashboard value silently shadowed it.

Only those four names can be written. That list is a security boundary, not
tidiness — accepting arbitrary names from a web form would let someone set
`NODE_OPTIONS` and run code in the server process.

`DATABASE_URL` is deliberately not manageable there, and cannot be: reading
`app_secrets` requires a connection, and the connection requires that value.
It is the one credential that has to stay in the host environment.

### Images on IPFS

Originals are pinned to IPFS through Pinata and the CID recorded in
`asset_pins`, keyed by **content digest** rather than path — a CID is derived
from the bytes, so keying on the digest means an image reused at two paths is
pinned once and re-saving an unchanged image costs nothing. In practice 20
uploads covered 21 images on the current site.

IPFS is the record, not the serving path. The build generates responsive
derivatives that took the homepage from 5 MB to 91 KB; serving full-size
originals through a gateway would undo that and put a third party in front of
every page load.

Pinning is therefore never load-bearing. A save writes to Postgres, rebuilds,
and returns — the upload happens afterwards, unawaited. If it fails, the image
is already durable and the page already correct; the reason is recorded in
`asset_pin_failures` with an attempt count, because "not pinned" otherwise
cannot be told apart from "not tried yet" by anyone who cannot read the log.

Manage it at **/admin/ipfs**: counts, failures with their reasons, and the
pinned images with gateway links. Backfilling runs 20 images per click, so a
request cannot outlive a proxy — click again until it reports none left. It is
deliberately never done on boot: the first run uploads every image on the
site, and a deploy is not the moment to discover how long that takes.

### Encryption

Images are encrypted with AES-256-GCM before they are uploaded, so a CID on
its own reveals nothing. This is done before the bytes leave the process, not
after: IPFS cannot un-publish anything, so a plaintext upload is permanent
whatever happens next.

`IPFS_ENCRYPTION_KEY` is generated on first boot and kept in `app_secrets`.
**Keep a copy elsewhere.** A key that only exists in the database dies with it,
and the pinned copies then stop being a backup and become noise. The owner can
display it once from **/admin/credentials** — the one deliberate exception to
values never being shown.

Turning encryption on re-pins each image and unpins the plaintext copy. That
stops this account serving it; it cannot recall anything already fetched by
somebody else, which is why the order matters.

A gateway link therefore returns ciphertext rather than a picture. That is the
intended behaviour, and the admin says so rather than looking broken.

Worth being clear about what this does and does not buy: these same images are
public on the website, so encryption does not make them secret. It stops the
IPFS copy being an independently readable dump of the site's assets, and it
puts the mechanism in place before genuinely private material — attendee
photos, profile data — exists.

`PINATA_JWT` alone is enough. The legacy key and secret are only for accounts
still on v2 auth. `PINATA_GATEWAY` should be the bare host — the public
ipfs.io gateway is rate-limited, and is only the fallback.

### The attendee portal

`/portal` is for the people attending. Separate from `/admin` in every way
that matters: its own table, its own cookie, its own session store. An
attendee is never one accidental join away from editor privileges, and cannot
change their own role or email address -- the form does not offer it and the
handler refuses it, because a form is not a security boundary.

**Registration is open; admission is not.** Anyone may create an account at
`/portal/register` -- it is identity, not a place at the event. A ticket is
issued separately from **/admin/attendees**, which is what makes the guest
list a whitelist rather than a race for the first hundred sign-ups.

That makes verification necessary rather than optional: with open
registration anybody can type somebody else's address. A ticket cannot be
issued to a self-registered address that has not been confirmed, and the rule
lives in the store so the admin screen cannot bypass it. An address an admin
typed needs no click -- a person vouched for it, which is a better signal.

Neither the sign-in form, the forgotten-password form, nor registration will
reveal whether an address already has an account. All three answer
identically, and all run the full key derivation, so timing does not give away
what the wording refuses to. Registration also carries a honeypot, and a
filled one is answered as though it succeeded.

**Tickets** are numbered in one sequence: 1-33 VIP, 34-100 general, shown as
`1/33` and `34/100`. A database constraint enforces the mapping, so capacity
comes from the range rather than from counting rows and hoping two
registrations do not race. The lowest free number in the tier is claimed in a
single statement, with the unique index as the backstop. Withdrawing a ticket
frees its number.

The QR encodes `/t/<code>` on this site, so door staff scan it with any phone
rather than needing an app. The code is the credential: a valid one shows its
holder, an invalid one reveals nothing, a malformed one is not looked up.

**Speakers** live in `src/_data/speakers.json` as content, because there are
no email addresses for most of the thirty-three. Linking an account to its
published entry by slug (from the guest list) lets that speaker maintain their
own listing: saving their profile writes their name, role, company, biography
and LinkedIn onto the public page and rebuilds it. Their slug, photo and
ordering stay with the organisers.

### Badges

Every badge holder gets a printable badge at **/admin/badges**, filterable by
category, eight to an A4 sheet at 90x65mm. Plain HTML with a print stylesheet
rather than a generated PDF: no dependency, it reflows if the stock changes,
and whoever is printing sees what will come out first.

The badge carries the same QR as the ticket, pointing at `/t/<code>` here, so
one scan works whether somebody presents a badge, a phone, or a wallet pass.

**Categories are data**, managed at **/admin/categories**. Speaker, VIP and
Visitor ship with the event and cannot be removed -- removing one would strand
its badges -- but they can be renamed, recoloured and renumbered. Add your own
(Press, Staff, Sponsor) with their own block of numbers, or leave the numbers
blank for a badge that states a category without a place in a sequence, which
is how Speaker starts.

Two rules are worth knowing:

- **Ranges must not overlap.** Two categories drawing on the same numbers
  would hand two people the same badge number, and the symptom would surface
  much later as an inexplicable "none left".
- **A withdrawn number is never reissued.** A printed badge carrying it may
  still be in a pocket, so the next badge takes the next number.

The range rule survived becoming data. A CHECK constraint cannot read another
table, so a trigger on `tickets` enforces it -- which means a caller that
forgets the rule, or a category edited later, still cannot issue a number
outside its range. There is a test that inserts straight SQL to prove it.

### Keeping tests away from live data

The Postgres tests truncate tables, so two guards stand between `npm test` and
live content:

- every test that boots the server sets `SKIP_ENV_FILE=1` and clears
  `DATABASE_URL`, so a real `.env` cannot reach it. Deleting the variable
  alone would not do it — absent is exactly when the loader fills it in from
  the file;
- the Postgres tests use a separate `TEST_DATABASE_URL` and refuse to run
  unless it is plainly local, printing why. `ALLOW_DESTRUCTIVE_DB_TESTS=1`
  overrides that, deliberately awkwardly;
- the files run one at a time (`--test-concurrency=1`). Several truncate the
  same tables, and in parallel they deleted each other's rows mid-test --
  eleven failures where every file passed on its own.

```bash
docker run -d --name regsymp-dev-pg -e POSTGRES_PASSWORD=dev   -e POSTGRES_DB=regsymp -p 55432:5432 postgres:18
TEST_DATABASE_URL=postgresql://postgres:dev@127.0.0.1:55432/regsymp npm test
```

### Confirming storage is real

```bash
curl -s https://regsymp.com/api/health | jq .content
```

`backend` is `postgres` or `filesystem`. With Postgres, `durable` is `true` by
construction and the response also reports document, revision and account
counts plus which migrations have run. With the filesystem fallback, see
below — an unmounted volume looks identical to a mounted one until a deploy
erases it.

### Confirming the volume is real

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

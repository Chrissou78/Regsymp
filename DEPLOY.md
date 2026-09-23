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

### Signing in

One form, at `/portal/signin`, reached from **Connect to Profile** in the
navigation, the hero and the footer. `/admin/signin` still works, but nobody
has to remember it.

**The two credential stores are not merged.** Admin passwords stay in
`admin_users`, attendee passwords in `attendees`, and the form checks both. An
address that exists in both — with different passwords — gets both cookies;
matching one grants only what that one grants. An attendee session presented
to `/admin` is still bounced to the admin sign-in, and there is a test for it.
What is shared is the form, not the authorisation.

The menu shows an **Admin** link only to admins. The pages are static, so it
cannot know at build time: the server sets a readable `regsymp_who` cookie
alongside the real session cookies, which stay `HttpOnly`, and `site.js`
reveals the link from it. That cookie grants nothing — every route still
checks the session — it only decides which links to draw.

A signed-in attendee sees **My Profile** instead of Connect to Profile. An
admin with no attendee profile has the Admin link and no account link, since
showing both put the word "Admin" on screen twice.

Two things had to be fixed to make this work, both the same shape of bug:
an author `display` rule outranks the user-agent rule for `[hidden]`, so an
element hidden from script stayed on screen until `[hidden]` was given
`display: none !important`; and the admin cookie was scoped to `Path=/admin`,
where the site's own navigation could never see it.

### The invitation form

Retired. With registration open, somebody who wants in creates an account and
the organisers issue a badge, so a form asking to be invited is a second,
worse path to the same place. `/api/request-invitation`, its tests and
`partials/invite-modal.njk` all remain in the repository if it is ever wanted
back — nothing includes or links to it.

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

### Selling a seat

Seats are sold through **Stripe Checkout**. The card details are entered on
Stripe's own page and never reach this site, which is the whole reason for the
redirect and worth the redirect.

**Prices live here, not at Stripe.** A price belongs to an event *and* a badge
category together -- a VIP seat at Davos is not a VIP seat at Mallorca -- and
is set on the event's own page at **/admin/events/&lt;slug&gt;**. Two things are
separate on purpose:

- **Priced** is a number somebody has agreed.
- **On sale** is whether it can be bought today.

Prices are usually agreed weeks before the seats open, and a category with no
price at all is not for sale. That is the default, and the alternative --
everything buyable at zero until somebody notices -- has an obvious failure
mode.

Paying issues the badge automatically, in the category paid for. The buyer gets
an account if they do not have one, a claim link by email, and their badge is
waiting in their profile.

#### Turning it on

1. Set `STRIPE_SECRET_KEY` at **/admin/credentials**. Until then /tickets says
   the seats are not on sale, which is true, and nothing else changes.
2. In the Stripe dashboard add a webhook endpoint pointing at
   `https://<host>/api/stripe/webhook`, subscribed to
   `checkout.session.completed`, `checkout.session.expired` and
   `checkout.session.async_payment_failed`.
3. Set `STRIPE_WEBHOOK_SECRET` (it starts with `whsec_`) at
   **/admin/credentials**.

   Point the endpoint at the **origin host**, not at a proxy in front of it.
   The signature covers the raw bytes, and anything that re-encodes a body on
   the way through turns every webhook into a 400 for a reason that looks
   nothing like the cause. On Vercel that means the server's own hostname, not
   `regsymp.vercel.app`.
4. Price the categories on the event's page and tick **On sale**.

#### Selling into somebody else's account

Set `STRIPE_ACCOUNT` to a connected account (`acct_…`) and the money goes
there instead of into this platform's balance. `STRIPE_CONNECT_MODE` decides
how, and the two are not interchangeable:

- **`direct`** (the default). Requests carry a `Stripe-Account` header, so the
  connected account is the merchant of record: its name on the statement, its
  balance, its liability for a dispute. Its events are delivered to a
  **Connect** webhook endpoint and carry an `account` field.
- **`destination`**. This platform is the merchant of record and the money is
  transferred on, with `on_behalf_of` set so the buyer still sees a name they
  recognise. Events arrive on the platform's own endpoint.

Which is right is a question about who the buyer is contracting with.

With direct charges the endpoint receives events for **every** account
connected to this platform, and this endpoint issues badges. So the account on
each event is checked against `STRIPE_ACCOUNT` and anything else is refused: a
signature proves Stripe sent it, only the account proves it is ours.

#### Refunds

A refund arrives as `charge.refunded`, carrying its payment intent rather than
its session — which is why the intent is recorded against every payment. The
payment goes to `refunded` and stops counting towards the takings.

**The badge is deliberately left alone.** Whether a refunded seat should be
withdrawn is a decision about a person — they may have been refunded a
difference, or comped — so /admin/payments flags the pair in red and somebody
decides. Subscribe to `charge.refunded` alongside the others if you want this
to happen automatically rather than by hand.

Step 3 is the one that gets forgotten, and forgetting it means money taken and
no badge issued. **/admin/payments** says so in red when the secret is missing,
and `/api/health` reports `payments.checkout` and `payments.webhook` separately
for exactly this reason.

#### Why the webhook issues the badge, and not the page after paying

Because that page is optional. People close the tab, lose signal in a taxi, pay
on a phone that goes flat. The webhook is the only event Stripe guarantees to
deliver, so it is the only place a seat may be granted.

Which brings the two rules the schema enforces:

- **`payments.session_id` is unique.** Stripe retries a webhook for three days
  and says plainly that an endpoint may see the same event more than once. The
  "mark as paid" update is conditional on the row still being pending and
  returns nothing if it is not, so a redelivered webhook stops at the door
  rather than issuing a second badge.
- **The signature is checked against the raw bytes.** Verified by hand rather
  than by the SDK: split the `Stripe-Signature` header, rebuild
  `timestamp + "." + body`, HMAC-SHA256 it with the `whsec_` secret and compare
  in constant time, rejecting anything older than five minutes. A body that has
  been parsed and re-serialised will not verify, which is why the route reads
  the body before anything else touches it.

A bad signature gets a 400 -- Stripe gives up on a 4xx, and an unverifiable
body will not become verifiable on the tenth try. A database failure gets a
500, so Stripe retries and the badge is issued on the retry rather than quietly
forgotten.

#### Testing it without real money

Stripe's test keys (`sk_test_...`) work everywhere the live ones do. For the
webhook, `stripe listen --forward-to localhost:3000/api/stripe/webhook` prints
a `whsec_` of its own -- use that one while testing, and remember to put the
real one back.

The seats are never sold while the site is asleep. The webhook is exempt: money
already taken has to become a badge whatever the front door says.

### A badge belongs to an event

The same person can hold a badge at Palma and another at Davos, buy a seat at
both, and redeem each when its event comes round. Two rules that were written
when there was only ever one event are now per event, and both are enforced by
the schema rather than only by the code that issues badges:

- **One badge per person, per event** (`tickets_one_per_event`).
- **One holder per number, per event** (`tickets_number_held`). Numbering
  starts again at each event, so thirty-three VIP seats at Palma and
  thirty-three at Davos are sixty-six seats rather than a range used twice.

Everywhere a badge is issued, withdrawn, printed or counted now takes an event,
defaulting to the live one. The guest list and the badge sheet carry the same
`?event=<slug>` switcher as the per-event collections, and the guest list shows
which event it is looking at — attributing a Davos badge while believing you
are looking at Palma is a mistake nobody notices until the door.

In the portal, somebody with several badges sees them all on their profile,
each on its own page at `/portal/ticket?event=<slug>`, each claimed and added
to a wallet separately. A scan at the door reports which event the badge
admits to, because a badge from the wrong event is a valid badge and still the
wrong answer.

### The 33

**/next/** is six square photographs, one per upcoming edition, built from the
`events` table — so announcing an edition is adding a row and swapping a
photograph is editing `image_path` on the event's page in the admin. Neither
is a change to a template.

A card is a button rather than a link. The editions have no pages of their own
and there is nowhere honest for a link to go; what it opens is the
register-interest form with that edition already ticked.

**Registering interest is not a booking.** The 33 is convened by invitation, so
the form records a name, an address, a company and which editions somebody
asked about, and nothing else happens: no account, no badge, no charge. That is
why it has its own table (`the33_interest`) rather than being a pending
attendee or an unpaid payment — both of those are things somebody would later
be tempted to turn into an admission automatically. There is a test that
asserts a submission creates no attendee and no ticket.

- **`POST /api/the-33`** takes the page's JSON and, for a browser with no
  JavaScript, the same form's ordinary post. The editions are checked against
  the ones the site is actually announcing, so the list a chair reads in an
  email cannot be written by whoever submitted the form.
- **/admin/interest** is the list, with how many people want each edition at
  the top and a CSV download. Marking somebody invited records that a chair
  decided to; it sends nothing. An invitation to a private dinner is a letter
  from a person.
- The chairs are notified at `INVITATION_RECIPIENT`, with `Reply-To` set to the
  person. A failed send does not lose the row — it is already saved.

**Photography.** The six shipped images are placeholders from Wikimedia
Commons, graded to one treatment, and carry an attribution requirement. The
page says so in a credits line, editable at **/admin/upcomingCopy**, which
should be emptied once real photography replaces them.

Replacing one is an upload on the event's own page: choose a file and it lands
in `src/assets/images/the33/`, the event's `image_path` is pointed at it and
the site rebuilds. Square, and large enough to stand being displayed at 800px
— the build makes the responsive derivatives. Leaving the file box empty
changes nothing, so saving an event does not require re-uploading its picture.

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
- Sessions are held server-side in the `sessions` table; the cookie carries
  only an opaque id, and is `HttpOnly`, `Secure` and `SameSite=Lax`.
- **A restart no longer signs anybody out.** Sessions were in memory, which
  was defensible until the navigation began showing an "Admin" link from a
  readable cookie that outlived the server: after every deploy the menu said
  you were signed in and the first click bounced you to sign in again. One
  table holds both populations, kept apart by `kind`, so signing out of the
  portal cannot reach an admin session.
- The readable hint corrects itself. Whenever a surface turns an
  unauthenticated request away it removes its own role from `regsymp_who`, so
  a hint that has outlived its session stops being offered as a link.

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

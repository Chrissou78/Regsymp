# Admin Interface — Design

**Date:** 2026-08-27
**Status:** Approved pending review
**Deploy target:** `OC-Labs/regsymp`, branch `prod` (what 91.99.21.245 auto-deploys)

## Context

Content lives in seven JSON files under `src/_data/`, and Eleventy renders them
at build time. Every content change is currently a code change: edit JSON,
commit, push, wait for the deploy. That is fine for a developer and impossible
for anyone else, and it makes routine work — adding a speaker, swapping a logo
— disproportionately heavy.

A full build takes 18 seconds, so the static architecture is not the obstacle.
The obstacle is that editing requires a git client.

## Goal

An authenticated `/admin` interface, served by the existing `server.js`, that
can create, edit, reorder and delete records in every `src/_data/` file and
upload the images they reference — with each change committed to git, so
history, attribution and rollback are preserved.

## Non-goals

- No database. Git stays the single source of truth.
- No client-side framework. Server-rendered HTML, progressively enhanced.
- No draft/publish workflow, no scheduling, no multi-user roles. Every
  allowlisted user has the same rights.
- No editing of templates, CSS or code. Data only.

## Architecture

The interface is **schema-driven**. One declarative description per collection
drives the list view, the edit form, validation and the write. Adding a
collection later is a schema entry, not new UI code.

```
admin/
  schemas.js    field definitions and validation per collection
  auth.js       GitHub OAuth, allowlist, server-side sessions
  github.js     read and commit files via the GitHub Contents API
  sanitise.js   filename slugs and HTML allowlisting
  render.js     HTML rendering helpers
  routes.js     route table, mounted by server.js
```

`server.js` gains one line to mount the admin router; the static and
invitation-endpoint behaviour is untouched.

### Data flow

```
edit → validate against schema → serialise JSON
     → commit to OC-Labs/regsymp@prod via Contents API (author = the signed-in user)
     → auto-deploy rebuilds → live
```

Nothing is written to the container filesystem. That matters: the Railpack
container has ephemeral storage, so anything written locally is lost on the
next deploy. Committing directly to git sidesteps that entirely.

## Collections

| File | Shape | Editor |
|---|---|---|
| `speakers.json` | array of records | list + record form |
| `partners.json` | array of tiers, each holding a `logos` array | nested list |
| `faq.json` | array of `{question, answer}` | list + record form |
| `themes.json` | array of `{num, title, description}` | list + record form |
| `editions.json` | array of `{key, label, url}` | list + record form |
| `agenda.json` | object: edition → `day1` / `day2` arrays | nested list |
| `site.json` | single object | settings form |

### Schema shape

```js
export const speakers = {
  file: "src/_data/speakers.json",
  kind: "array",
  label: "Speakers",
  identify: (r) => r.name,
  fields: [
    { name: "slug",     type: "slug",  from: "name", required: true, unique: true },
    { name: "name",     type: "text",  required: true, max: 120 },
    { name: "role",     type: "text",  required: true, max: 160 },
    { name: "org",      type: "text",  max: 200 },
    { name: "orgHtml",  type: "html",  allow: ["strong", "em", "br"], help: "Optional. Use to emphasise part of the organisation name." },
    { name: "bio",      type: "textarea", max: 2000 },
    { name: "photo",    type: "image", dir: "src/assets/images/speakers" },
    { name: "linkedin", type: "url" }
  ]
};
```

Field types: `text`, `textarea`, `slug`, `url`, `html`, `image`, `select`,
`number`, `checkbox`. Each type owns its validation and its form control, so
the renderer stays generic.

Records are reorderable — the JSON array order is the render order on the site,
so the list view offers move up / move down.

## Authentication

GitHub OAuth, because the editors already have GitHub accounts and it gives
per-user attribution in git history without storing any password.

1. `GET /admin` — no session, so render a sign-in page.
2. `GET /admin/auth` — redirect to GitHub `authorize` with `state` (CSRF).
3. `GET /admin/auth/callback` — verify `state`, exchange the code for a token,
   fetch the user, reject anyone not on the allowlist, create a session.
4. Session id in an opaque cookie: `httpOnly`, `Secure`, `SameSite=Lax`,
   8-hour expiry.

**The OAuth token never reaches the browser.** Sessions are held server-side in
a `Map` with a TTL sweep; the cookie carries only a random identifier. A
container restart clears sessions, which means signing in again — acceptable
for this number of users, and avoids adding a session store.

Environment:

| Variable | Purpose |
|---|---|
| `GITHUB_CLIENT_ID` | OAuth app |
| `GITHUB_CLIENT_SECRET` | OAuth app |
| `ADMIN_ALLOWLIST` | comma-separated GitHub usernames |
| `CONTENT_REPO` | `OC-Labs/regsymp` |
| `CONTENT_BRANCH` | `prod` |
| `SESSION_SECRET` | signing key for CSRF tokens |

`CONTENT_REPO` and `CONTENT_BRANCH` are configuration rather than constants, so
retargeting the admin at a different repo is an env change.

## Images

Upload handling is the part most likely to cause a production bug, because it
is the one place an editor introduces filenames.

1. Accept `image/jpeg`, `image/png`, `image/webp`, `image/svg+xml`. Reject on
   sniffed magic bytes, not on the declared content type.
2. Cap at 8 MB.
3. **Slugify the filename**: lowercase, strip accents, replace runs of
   non-alphanumerics with `-`, normalise the extension.
   `Rony Vogel.png` → `rony-vogel.png`; `Martín L. Aleñar Feliu..jpg` →
   `martin-l-alenar-feliu.jpg`.
4. Commit the binary to the collection's `dir`, base64-encoded.
5. If the target name exists, suffix `-2`, `-3`, … rather than overwrite.

Step 3 is the whole point. Four speaker photos and every carousel image were
404ing in production because their paths differed in case from the files on
disk — invisible on Windows and macOS, fatal on Linux. A media library that
preserves the uploaded name would reintroduce that class of bug on the first
upload. `tests/assets.test.js` already asserts every reference resolves with
exact case; slugification keeps that test passing by construction.

Deleting an image is deliberately not offered — a file may be referenced from
somewhere the admin cannot see, and an orphaned image is harmless.

## Security

**CSRF.** Every mutating request carries a token derived from the session id via
HMAC with `SESSION_SECRET`, checked before any write.

**HTML sanitising.** `orgHtml` renders through Nunjucks `| safe`, so unfiltered
admin input is a stored-XSS vector. `html` fields are parsed and reduced to an
allowlist of tags with no attributes; anything else is stripped.

**Rate limiting.** The OAuth callback and sign-in routes are limited per IP to
blunt brute-force and code-replay attempts.

**Optimistic concurrency.** The Contents API requires the blob SHA of the file
being replaced. The edit form carries the SHA it loaded; a mismatch means
someone else committed first, and the user is shown a conflict rather than
silently overwriting.

**Authorisation.** Every `/admin` route except the sign-in and callback checks
the session first. A test asserts each route rejects an unauthenticated
request — a route added later without a guard should fail the suite.

## Branch workflow

`prod` currently receives force-pushes (`git push prod prod
--force-with-lease`) on every deploy, which rewrites it to match `main`. Once
the admin commits content to `prod`, **that would destroy content edits.**

The rule from here:

- Content commits land on `OC-Labs/regsymp@prod`, made by the admin.
- Code changes flow `origin/main` → **merged** into `prod` → pushed without
  `--force`.
- `prod` is never force-pushed again.

Vercel builds from `Chrissou78/Regsymp@main` and will therefore not see content
edits. regsymp.com — served from the box — stays correct. Whether to keep
Vercel in sync, retarget it at `prod`, or retire it is a separate decision and
not part of this work.

## Interface

Server-rendered, styled with the site's existing tokens (`--navy-deep`,
`--gold`, Inter) so it reads as part of RegSymp rather than a bolted-on tool.

- `/admin` — collection index with record counts
- `/admin/:collection` — list view, reorder, delete, "add new"
- `/admin/:collection/:id` — record form
- `/admin/signin`, `/admin/auth`, `/admin/auth/callback`, `/admin/signout`

Forms are ordinary HTML `POST`s and work without JavaScript. JavaScript adds
image preview and drag-to-reorder as enhancements only.

After a successful commit the user sees the commit SHA, a link to it on GitHub,
and a note that the deploy takes a minute or two. No fake progress bar; the
admin does not know when the deploy finishes.

## Testing

Added to the existing 50-test suite:

- **Schema validation** — required fields, max lengths, URL and slug formats,
  uniqueness, and that a valid record round-trips through serialise/parse
  unchanged.
- **Slugification** — the real filenames that caused production 404s, including
  accents, spaces, capitals, double dots and a trailing space.
- **HTML sanitising** — `<strong>` survives, `<script>`, `onerror=` and
  `javascript:` do not.
- **Auth guards** — every admin route returns a redirect or 401 without a
  session; a parametrised test iterates the route table so a new unguarded
  route fails.
- **CSRF** — a mutating request without a valid token is rejected.
- **Concurrency** — a stale blob SHA produces a conflict, not an overwrite.
- **GitHub client** — against a stubbed API: correct paths, base64 encoding,
  branch targeting, and that a failed commit surfaces rather than reporting
  success.

No test touches the live GitHub API or commits anything.

## Risks

**A bad commit breaks the build and takes the site down.** Schema validation
runs before the commit, and the JSON is parsed back before writing, so
malformed data cannot be committed. A build failure leaves the previously
deployed version serving, but the admin will appear to have "worked" while the
site is stale. Mitigation: the success screen links to the commit so a failed
deploy is traceable. A pre-commit build check is a possible follow-up.

**Sessions are in memory.** A restart signs everyone out. Acceptable at this
scale; a persistent store is a follow-up if it becomes annoying.

**The admin is a new public attack surface.** OAuth with an allowlist, CSRF,
rate limiting and sanitising are the mitigations. `/admin` is added to
`robots.txt` as disallowed — obscurity is not security, but there is no reason
to have it indexed.

## Follow-ups

- Add the seven uploaded speaker photos through the new interface once it
  exists, rather than by hand.
- Decide whether Vercel is retired, retargeted at `prod`, or kept in sync.
- Consider running a build as a pre-commit check to catch data that would
  break rendering.

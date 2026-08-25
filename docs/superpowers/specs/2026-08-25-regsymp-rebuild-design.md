# RegSymp Site Rebuild — Design

**Date:** 2026-08-25
**Status:** Approved pending review
**Repo:** https://github.com/Chrissou78/Regsymp
**Host:** Vercel

## Context

The site is eight hand-maintained HTML files sharing a 1,751-line stylesheet. It works and reads well, but the structure has accumulated problems that an audit surfaced:

- Nav, footer and drawer markup are duplicated across six pages; the drawer JS across four. The copies have already drifted apart.
- The homepage ships 5.0 MB, 4.9 MB of which is three unoptimised images.
- No `width`/`height` on any of 47 `<img>` tags, so every page shifts on load.
- FAQ content exists twice — as visible markup and as `FAQPage` JSON-LD — and the two can drift silently.
- The FAQ page has no mobile navigation; `legal.html` has no nav or footer.
- Every call to action is a `mailto:`, so there is no lead capture at all.
- `speakers.html`, `partners.html` and `legal.html` have no canonical or OG tags.
- The privacy policy describes analytics the site does not have.

## Goals

Rebuild on a structure that makes these problems impossible rather than fixed once, while keeping the rendered site visually identical.

## Non-goals

- No visual redesign. Output should be pixel-equivalent except where a fix demands a change (the FAQ page gaining a mobile nav, and the homepage signup block below).
- No analytics tooling this pass. The privacy policy is corrected to match reality instead.
- No git history rewrite. The 70 MB `.git` stays; reclaiming it needs a force-push that breaks every clone, which is not worth 70 MB.

## Architecture

Eleventy, chosen over Astro and a hand-rolled script because its templates are ordinary HTML with includes — anyone who can edit the current site can edit the rebuilt one — and `@11ty/eleventy-img` already solves the image problem.

```
src/
  _data/
    site.json         name, url, contact, socials
    editions.json     the three city editions
    speakers.json
    agenda.json
    partners.json
    themes.json
    faq.json
  _includes/
    layouts/base.njk      head, meta, OG, canonical, JSON-LD
    partials/nav.njk
    partials/drawer.njk
    partials/footer.njk
    partials/speaker-card.njk
    partials/invite-modal.njk
  assets/
    css/styles.css
    js/site.js
    images/               full-resolution sources
  index.njk  speakers.njk  partners.njk  pillars.njk  faq.njk  legal.njk
  london-2027.njk  luxembourg-2027.njk
api/
  request-invitation.js   Vercel serverless function
.eleventy.js
vercel.json
package.json
_site/                    build output, gitignored
```

URLs are unchanged: `/`, `/speakers`, `/partners`, `/pillars`, `/faq`, `/legal`, plus `/london-2027` and `/luxembourg-2027`.

## Data model

Content that appears more than once must come from one source.

**`faq.json`** drives both the visible FAQ page and the `FAQPage` structured data, which today are separate copies that can disagree.

**`speakers.json`** — one record generates the card, its grid position, and its `Person` structured data:

```json
{
  "slug": "martin-alenar",
  "name": "Martín L. Aleñar Feliu",
  "role": "Partner",
  "org": "Bufete Buades",
  "orgUrl": "https://bufetebuades.com",
  "photo": "martin-alenar.jpg",
  "bio": "…",
  "linkedin": "https://www.linkedin.com/in/…"
}
```

The `Person` schema currently sits on the homepage pointing at a `#speakers` anchor that no longer exists. Generating it from this data moves it to the speakers page with correct URLs as a side effect.

**`editions.json`** — the three editions, driving the city selector:

| key | label | url |
|---|---|---|
| `palma` | Palma de Mallorca 2026 | `/` |
| `london` | London 2027 | `/london-2027` |
| `luxembourg` | Luxembourg 2027 | `/luxembourg-2027` |

The selector becomes a navigator between three real pages rather than an in-place agenda swap, since each edition has its own hero, copy and OG card.

## Asset pipeline

`@11ty/eleventy-img` runs at build over `src/assets/images/`, emitting content-hashed responsive variants and real `width`/`height` attributes.

| Usage | Widths | Formats |
|---|---|---|
| Full-bleed backgrounds | 1200 / 1800 / 2400 | WebP + JPEG |
| Speaker portraits | 400 / 800 | WebP + JPEG |
| Carousel | 600 / 1200 | WebP + JPEG |
| Logos and marks | passthrough | PNG / SVG |

Below-fold backgrounds get `loading="lazy"`; the hero keeps `fetchpriority="high"`. Hashed filenames make a one-year immutable cache safe.

**Known limitation:** all six AI-generated images are natively 832×1248 and will be served at that size. They become roughly 150 KB each instead of 1.4 MB — the full weight win — but no sharper than today. The original generation prompts are preserved in the source filenames. Regenerating at ~2400px wide is a follow-up; the pipeline picks up larger sources with no code change.

Affected files: `the-setting-palma.png`, `thirty-three-dinner.png`, and four carousel images. Two speaker photos are also below card resolution (`jorge-soriano.jpg` 417×572, `Raimundo Alvarino.jpg` 508×1148).

Target: homepage under 600 KB, from 5.0 MB.

## Invitation request modal

Replaces the `mailto:` calls to action, which capture nothing.

**Triggers:** the "Request an Invitation" / "Request an Invite" links in nav, hero, drawer and footer, plus the new button in the homepage closing section. Speaking-enquiry and general-contact `mailto:` links are left alone — different intents.

**Progressive enhancement:** the trigger stays a real `mailto:` anchor; JS upgrades it to open the modal. If scripts fail the link still works.

**Fields:**

| Field | Required |
|---|---|
| Name | yes |
| Email | yes |
| Company | yes |
| Mobile | no |
| Message | no |
| Consent checkbox | yes |

Required-ness of Mobile is a judgment call, not a stated requirement — making it mandatory will cost submissions. One-line change either way.

The consent checkbox links to the privacy policy. The form collects name, email, mobile and company from EU residents for a Spanish event, so this is GDPR territory.

**Dialog semantics:** `role="dialog"`, `aria-modal="true"`, labelled by its heading, focus trapped while open, Escape closes, focus restored to the trigger on close, background scroll locked.

**Spam handling:** a hidden honeypot field plus a minimum time-to-submit check, rather than a CAPTCHA — making a senior executive solve a puzzle to request an invitation is the wrong first impression. Optional IP rate limiting via Vercel KV; documented as an upgrade rather than assumed, since serverless functions are stateless and in-memory counters are best-effort only.

### Homepage closing section

The `#signup` section currently pairs the heading "Request an Invitation." with copy about quarterly briefings and a beehiiv **newsletter** email embed — two different intents in one block. The email field and its submit control are replaced by a single "Request an Invitation" button opening the modal.

Two consequences to settle before implementation:

1. The existing lede — "Quarterly briefings on the themes shaping RegSymp, and first access when the next edition opens" — describes a newsletter that will no longer be subscribable here. It needs rewording to match an invitation request.
2. Removing the beehiiv embed removes the site's only mailing-list capture. If the newsletter still matters, it needs a home elsewhere; otherwise the beehiiv integration and its `attribution.js` script are dropped entirely.

### API

`POST /api/request-invitation` — a Vercel serverless function.

1. Reject if the honeypot is filled or the form was submitted implausibly fast.
2. Validate required fields and email shape server-side. Never trust the client.
3. Send via Resend to the site contact address, with `reply-to` set to the submitter so replying works directly from the inbox.
4. Return JSON. The modal shows an inline success or error state; it never navigates away.

Environment variables (set in Vercel, never committed):

- `RESEND_API_KEY`
- `INVITATION_RECIPIENT` — `info@regsymp.com`
- `RESEND_FROM` — a verified sender on `regsymp.com`

**Prerequisite:** Resend requires SPF and DKIM records on `regsymp.com` before it will send reliably. This is a DNS change on the live domain and needs doing before the form can work in production.

## Behaviour

The JS duplicated across four files becomes one `site.js`: nav scroll state, drawer, city selector, agenda tabs, gallery arrows, reveal observer, and the invitation modal. The focus-trap utility is shared between drawer and modal.

## Accessibility fixes

- Drawer gains a focus trap and Escape-to-close.
- Agenda tabs gain `aria-controls` / `aria-labelledby` and arrow-key navigation.
- City selector options gain `aria-selected`.
- `:focus-visible` outline darkened from `#8B9BB4` (2.8:1 on white, below the 3:1 minimum for non-text contrast) to a compliant value.
- Decorative full-bleed backgrounds get `alt=""` so screen readers stop narrating scenery mid-content.

## SEO fixes

- The city selector stops overwriting `document.title`, which currently replaces the SEO title with a shorter one that drops "invite-only", "fintech" and "symposium".
- `Person` schema moves to the speakers page with working URLs.
- `FAQPage` schema generated from the same data as the visible page.
- Canonical and OG tags on every page.
- OG images generated for the London and Luxembourg editions; both currently reference files that do not exist.
- `sitemap.xml` and `robots.txt` generated at build.
- A visually hidden descriptive `<h1>` alongside "The Ninety Nine." — invisible, so the design is untouched, but the homepage stops telling search engines nothing.
- The footer FAQ link loses its stray `target="_blank"`.

## Legal

`legal.html` states the site "uses a small number of first-party cookies for basic site analytics". No analytics exist. The wording is corrected to describe the site as it actually is, and extended to cover what the invitation form collects, why, and how long it is kept.

## Deployment

`vercel.json` carries `cleanUrls` (already committed, since Vercel does not strip `.html` the way Netlify does), plus cache headers: `/assets/*` immutable for one year, HTML revalidating every request. This replaces the `no-cache, no-store` meta tags in the current `<head>`, which cause the full 5 MB to be re-downloaded on every visit.

Build command `npx @11ty/eleventy`, output directory `_site`.

The rebuild lands on a branch, giving a Vercel preview URL alongside the live site for comparison before merge.

## Deletions

`export/` (stale May 2026 copy), `assets/hero.mp4` (17 MB, referenced only by that stale copy), `uploads/` (old Toronto-edition mockups), `Mallorca palma design.png`, and the committed `.DS_Store`. The brand guidelines `.docx` stays — 15 KB of genuine reference material.

## Verification

"Same look" is a claim that has to be demonstrated:

1. Screenshot every page at 375 / 768 / 1440 and compare against the current site section by section.
2. Build fails on any missing asset reference.
3. Link check across all pages, internal and external.
4. Before/after page weight reported per page.
5. Invitation form tested end to end against a real Resend key, confirming delivery and that reply-to resolves to the submitter.

## Follow-ups

- Regenerate the six 832×1248 images at ~2400px.
- Replace the two below-resolution speaker photos.
- Consider analytics, which would make the original privacy policy wording true and give real visitor data.
- Consider storing submissions as a queryable record rather than only emailing them.
